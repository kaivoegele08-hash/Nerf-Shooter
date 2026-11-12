/*
 * joycon_bt.c - Nintendo Switch Joy-Con over the Wii's own Bluetooth,
 * presented to games as a (fake) Wii Remote.
 *
 * Connection flow (mirrors what worked in the "Joy-Con Bridge" homebrew app):
 *   1. The Joy-Con addresses come from JOYCON_CONF_PATH on NAND.
 *   2. While the game's Bluetooth stack is up, we page the Joy-Con every few
 *      seconds (it answers while its sync button is held), or accept the
 *      connection if the Joy-Con pages us.
 *   3. Legacy pairing: PIN = the Wii's own Bluetooth address (like libogc).
 *   4. L2CAP HID control (PSM 0x11) and interrupt (PSM 0x13) channels.
 *   5. Joy-Con init: device info, IMU on, vibration on, report mode 0x30,
 *      player LEDs.
 *   6. The Joy-Con is registered as an input device; fakemote's fake Wiimote
 *      manager then connects a fake Wii Remote to the game for it.
 *
 * Everything runs in the OH1 thread (hook + 5 ms timer), no locking needed.
 */
#include <string.h>

#include "bt_host.h"
#include "button_map.h"
#include "fake_wiimote.h"
#include "hci.h"
#include "hci_state.h"
#include "input_device.h"
#include "joycon_bt.h"
#include "syscalls.h"
#include "utils.h"
#include "wiimote.h"

/* Timing in 5 ms ticks */
#define TICKS_PER_SEC        200
#define PAGE_RETRY_TICKS     (2 * TICKS_PER_SEC)
#define CONNECT_TIMEOUT      (12 * TICKS_PER_SEC)
#define SUBCMD_RETRY_TICKS   60
#define SUBCMD_MAX_TRIES     6
#define INIT_DELAY_TICKS     30
#define INPUT_TIMEOUT_TICKS  (3 * TICKS_PER_SEC)

/* L2CAP */
#define PSM_HID_CTRL 0x11
#define PSM_HID_INTR 0x13
#define CID_SIGNAL   0x0001
#define L2CAP_CMD_REJ       0x01
#define L2CAP_CONN_REQ      0x02
#define L2CAP_CONN_RSP      0x03
#define L2CAP_CFG_REQ       0x04
#define L2CAP_CFG_RSP       0x05
#define L2CAP_DISCONN_REQ   0x06
#define L2CAP_DISCONN_RSP   0x07
#define L2CAP_ECHO_REQ      0x08
#define L2CAP_ECHO_RSP      0x09
#define L2CAP_INFO_REQ      0x0A
#define L2CAP_INFO_RSP      0x0B

/* Joy-Con subcommands */
#define SUB_DEVICE_INFO 0x02
#define SUB_REPORT_MODE 0x03
#define SUB_PLAYER_LEDS 0x30
#define SUB_IMU_ENABLE  0x40
#define SUB_VIBRATION   0x48

#define JC_TYPE_LEFT  1
#define JC_TYPE_RIGHT 2
#define JC_TYPE_PRO   3

/* Joy-Con button bits (byte3 | byte4 << 8 | byte5 << 16) */
#define JB_Y       0x000001
#define JB_X       0x000002
#define JB_B       0x000004
#define JB_A       0x000008
#define JB_R_SR    0x000010
#define JB_R_SL    0x000020
#define JB_R       0x000040
#define JB_ZR      0x000080
#define JB_MINUS   0x000100
#define JB_PLUS    0x000200
#define JB_RSTICK  0x000400
#define JB_LSTICK  0x000800
#define JB_HOME    0x001000
#define JB_CAPTURE 0x002000
#define JB_DOWN    0x010000
#define JB_UP      0x020000
#define JB_RIGHT   0x040000
#define JB_LEFT    0x080000
#define JB_L_SR    0x100000
#define JB_L_SL    0x200000
#define JB_L       0x400000
#define JB_ZL      0x800000

/* Wii Remote accelerometer: 10 bit, 512 = 0 g, ~104 counts per g
 * (ACCEL_ZERO_G / ACCEL_ONE_G in wiimote.h). Joy-Con: 4096 counts per g. */
#define WM_ACC_PER_G (ACCEL_ONE_G - ACCEL_ZERO_G)

static const u8 RUMBLE_OFF[4] = { 0x00, 0x01, 0x40, 0x40 };
static const u8 RUMBLE_ON[4] = { 0x00, 0x99, 0x40, 0x66 };

typedef enum {
    JS_UNUSED = 0,
    JS_IDLE,
    JS_PAGING,     /* CREATE_CON / ACCEPT_CON sent, waiting for CON_COMPL */
    JS_LINKED,     /* ACL up, authenticating / opening L2CAP */
    JS_INIT,       /* L2CAP up, Joy-Con init sequence */
    JS_READY,
    JS_DISCONNECTING
} jc_state_t;

typedef enum {
    STEP_DEVICE_INFO = 0,
    STEP_IMU_ENABLE,
    STEP_VIBRATION,
    STEP_REPORT_MODE,
    STEP_PLAYER_LEDS,
    STEP_DONE
} init_step_t;

typedef struct {
    u16 local_cid;
    u16 remote_cid;
    bool open;          /* connection established */
    bool our_cfg_sent;
    bool our_cfg_done;  /* remote accepted our config */
    bool their_cfg_done;
} chan_t;

typedef struct {
    jc_state_t state;
    u8 addr[6]; /* little endian, as in HCI */
    u16 handle;
    u32 state_ticks;
    u32 idle_ticks;
    bool we_initiated;
    bool auth_done;

    /* link key from the last pairing (lost on reboot) */
    bool have_key;
    u8 key[16];

    chan_t ctrl, intr;
    u8 sig_ident;

    init_step_t step;
    int tries;
    u32 step_ticks;
    u8 pkt_counter;
    u8 type;

    /* latest input */
    u32 buttons;
    u16 stick_x, stick_y; /* raw 12 bit of the relevant stick */
    s16 acc[3];           /* raw sensor frame */
    u32 input_age;
    bool rumble;
    u8 leds;

    input_device_t *input_device;
    struct bm_ir_emulation_state_t ir_state;
} joycon_t;

static joycon_t joycons[JOYCON_MAX_ADDRS];
static u32 global_page_cooldown;

/* ------------------------------------------------------------------------ */
/* Config                                                                   */
/* ------------------------------------------------------------------------ */

void joycon_bt_load_config(void)
{
    static u8 buf[6 * JOYCON_MAX_ADDRS] ATTRIBUTE_ALIGN(32);
    int fd, ret;

    memset(joycons, 0, sizeof(joycons));
    fd = os_open(JOYCON_CONF_PATH, IOS_OPEN_READ);
    if (fd < 0)
        return;
    ret = os_read(fd, buf, sizeof(buf));
    os_close(fd);
    if (ret < 6)
        return;

    for (int i = 0; i < JOYCON_MAX_ADDRS && (i + 1) * 6 <= ret; i++) {
        const u8 *a = buf + i * 6;
        bool zero = true;
        for (int j = 0; j < 6; j++)
            if (a[j] != 0 && a[j] != 0xFF)
                zero = false;
        if (zero)
            continue;
        for (int j = 0; j < 6; j++)
            joycons[i].addr[j] = a[5 - j]; /* display order -> little endian */
        joycons[i].state = JS_IDLE;
        joycons[i].idle_ticks = PAGE_RETRY_TICKS;
    }
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                  */
/* ------------------------------------------------------------------------ */

static joycon_t *find_by_addr(const u8 *addr)
{
    for (int i = 0; i < JOYCON_MAX_ADDRS; i++)
        if (joycons[i].state != JS_UNUSED && memcmp(joycons[i].addr, addr, 6) == 0)
            return &joycons[i];
    return NULL;
}

static joycon_t *find_by_handle(u16 h)
{
    for (int i = 0; i < JOYCON_MAX_ADDRS; i++)
        if (joycons[i].state >= JS_LINKED && joycons[i].handle == h)
            return &joycons[i];
    return NULL;
}

bool joycon_bt_owns_handle(u16 con_handle)
{
    return find_by_handle(con_handle) != NULL;
}

static void set_state(joycon_t *jc, jc_state_t s)
{
    jc->state = s;
    jc->state_ticks = 0;
}

static void reset_link(joycon_t *jc)
{
    if (jc->input_device) {
        input_device_remove_custom(jc->input_device);
        jc->input_device = NULL;
    }
    memset(&jc->ctrl, 0, sizeof(jc->ctrl));
    memset(&jc->intr, 0, sizeof(jc->intr));
    jc->handle = 0xFFFF;
    jc->auth_done = false;
    jc->buttons = 0;
    jc->rumble = false;
    jc->idle_ticks = 0;
    set_state(jc, JS_IDLE);
}

static void hci_disconnect(joycon_t *jc)
{
    u8 p[3] = { jc->handle & 0xFF, jc->handle >> 8, 0x13 /* remote user terminated */ };
    bt_host_send_cmd(HCI_CMD_DISCONNECT, p, sizeof(p));
    set_state(jc, JS_DISCONNECTING);
}

/* ------------------------------------------------------------------------ */
/* L2CAP                                                                    */
/* ------------------------------------------------------------------------ */

static void l2cap_send(joycon_t *jc, u16 cid, const u8 *payload, u16 len)
{
    u8 buf[64];
    if (len + 4 > (int)sizeof(buf))
        return;
    buf[0] = len & 0xFF;
    buf[1] = len >> 8;
    buf[2] = cid & 0xFF;
    buf[3] = cid >> 8;
    memcpy(buf + 4, payload, len);
    bt_host_send_acl(jc->handle, buf, len + 4);
}

static void sig_send(joycon_t *jc, u8 code, u8 ident, const u8 *data, u16 len)
{
    u8 buf[48];
    if (len + 4 > (int)sizeof(buf))
        return;
    buf[0] = code;
    buf[1] = ident;
    buf[2] = len & 0xFF;
    buf[3] = len >> 8;
    memcpy(buf + 4, data, len);
    l2cap_send(jc, CID_SIGNAL, buf, len + 4);
}

static inline void put16(u8 *p, u16 v)
{
    p[0] = v & 0xFF;
    p[1] = v >> 8;
}

static inline u16 get16(const u8 *p)
{
    return p[0] | (p[1] << 8);
}

static void l2cap_connect(joycon_t *jc, chan_t *ch, u16 psm, u16 local_cid)
{
    u8 d[4];
    memset(ch, 0, sizeof(*ch));
    ch->local_cid = local_cid;
    put16(d, psm);
    put16(d + 2, local_cid);
    sig_send(jc, L2CAP_CONN_REQ, ++jc->sig_ident, d, 4);
}

static void l2cap_send_config(joycon_t *jc, chan_t *ch)
{
    u8 d[4];
    put16(d, ch->remote_cid);
    put16(d + 2, 0); /* flags */
    sig_send(jc, L2CAP_CFG_REQ, ++jc->sig_ident, d, 4);
    ch->our_cfg_sent = true;
}

static chan_t *chan_by_local(joycon_t *jc, u16 cid)
{
    if (jc->ctrl.local_cid == cid && cid)
        return &jc->ctrl;
    if (jc->intr.local_cid == cid && cid)
        return &jc->intr;
    return NULL;
}

static bool chan_ready(const chan_t *ch)
{
    return ch->open && ch->our_cfg_done && ch->their_cfg_done;
}

static void start_init(joycon_t *jc);

static void l2cap_progress(joycon_t *jc)
{
    if (jc->state != JS_LINKED)
        return;
    if (chan_ready(&jc->ctrl) && !jc->intr.local_cid && jc->we_initiated)
        l2cap_connect(jc, &jc->intr, PSM_HID_INTR, 0x0041);
    if (chan_ready(&jc->ctrl) && chan_ready(&jc->intr))
        start_init(jc);
}

static void handle_signal(joycon_t *jc, const u8 *d, u16 len)
{
    while (len >= 4) {
        u8 code = d[0], ident = d[1];
        u16 clen = get16(d + 2);
        const u8 *c = d + 4;
        if (clen + 4 > len)
            return;

        switch (code) {
        case L2CAP_CONN_REQ: { /* the Joy-Con opens a channel (reconnect) */
            u16 psm = get16(c), scid = get16(c + 2);
            chan_t *ch = psm == PSM_HID_CTRL ? &jc->ctrl : psm == PSM_HID_INTR ? &jc->intr : NULL;
            u8 r[8];
            if (ch) {
                memset(ch, 0, sizeof(*ch));
                ch->local_cid = psm == PSM_HID_CTRL ? 0x0040 : 0x0041;
                ch->remote_cid = scid;
                ch->open = true;
            }
            put16(r, ch ? ch->local_cid : 0);
            put16(r + 2, scid);
            put16(r + 4, ch ? 0 : 0x0002); /* success / PSM not supported */
            put16(r + 6, 0);
            sig_send(jc, L2CAP_CONN_RSP, ident, r, 8);
            if (ch)
                l2cap_send_config(jc, ch);
            break;
        }
        case L2CAP_CONN_RSP: {
            u16 dcid = get16(c), scid = get16(c + 2), result = get16(c + 4);
            chan_t *ch = chan_by_local(jc, scid);
            if (!ch)
                break;
            if (result == 0) {
                ch->remote_cid = dcid;
                ch->open = true;
                l2cap_send_config(jc, ch);
            } else if (result != 1) { /* 1 = pending */
                hci_disconnect(jc);
                return;
            }
            break;
        }
        case L2CAP_CFG_REQ: {
            u16 dcid = get16(c);
            chan_t *ch = chan_by_local(jc, dcid);
            u8 r[6];
            put16(r, ch ? ch->remote_cid : 0);
            put16(r + 2, 0); /* flags */
            put16(r + 4, 0); /* success */
            sig_send(jc, L2CAP_CFG_RSP, ident, r, 6);
            if (ch) {
                ch->their_cfg_done = true;
                if (!ch->our_cfg_sent && ch->open)
                    l2cap_send_config(jc, ch);
            }
            break;
        }
        case L2CAP_CFG_RSP: {
            u16 scid = get16(c), result = get16(c + 4);
            chan_t *ch = chan_by_local(jc, scid);
            if (ch && result == 0)
                ch->our_cfg_done = true;
            break;
        }
        case L2CAP_DISCONN_REQ: {
            u8 r[4];
            memcpy(r, c, 4);
            sig_send(jc, L2CAP_DISCONN_RSP, ident, r, 4);
            hci_disconnect(jc);
            return;
        }
        case L2CAP_ECHO_REQ:
            sig_send(jc, L2CAP_ECHO_RSP, ident, c, clen > 32 ? 32 : clen);
            break;
        case L2CAP_INFO_REQ: {
            u8 r[4];
            memcpy(r, c, 2);  /* info type */
            put16(r + 2, 1);  /* not supported */
            sig_send(jc, L2CAP_INFO_RSP, ident, r, 4);
            break;
        }
        default:
            break;
        }
        d += 4 + clen;
        len -= 4 + clen;
    }
    l2cap_progress(jc);
}

/* ------------------------------------------------------------------------ */
/* Joy-Con protocol                                                         */
/* ------------------------------------------------------------------------ */

static void jc_send_report(joycon_t *jc, const u8 *report, u16 len)
{
    u8 buf[51];
    if (!jc->intr.open || len + 1 > sizeof(buf))
        return;
    buf[0] = 0xA2; /* HIDP DATA | OUTPUT */
    memcpy(buf + 1, report, len);
    l2cap_send(jc, jc->intr.remote_cid, buf, len + 1);
}

static void fill_rumble(joycon_t *jc, u8 *dst)
{
    const u8 *r = jc->rumble ? RUMBLE_ON : RUMBLE_OFF;
    memcpy(dst, r, 4);
    memcpy(dst + 4, r, 4);
}

static void jc_subcmd(joycon_t *jc, u8 sub, const u8 *args, int alen)
{
    u8 r[49];
    memset(r, 0, sizeof(r));
    r[0] = 0x01;
    r[1] = jc->pkt_counter++ & 0x0F;
    fill_rumble(jc, r + 2);
    r[10] = sub;
    if (args && alen > 0 && alen <= 38)
        memcpy(r + 11, args, alen);
    jc_send_report(jc, r, sizeof(r));
}

static void jc_send_rumble(joycon_t *jc)
{
    u8 r[49];
    memset(r, 0, sizeof(r));
    r[0] = 0x10;
    r[1] = jc->pkt_counter++ & 0x0F;
    fill_rumble(jc, r + 2);
    jc_send_report(jc, r, sizeof(r));
}

static void send_step(joycon_t *jc)
{
    u8 a;
    switch (jc->step) {
    case STEP_DEVICE_INFO: jc_subcmd(jc, SUB_DEVICE_INFO, NULL, 0); break;
    case STEP_IMU_ENABLE:  a = 0x01; jc_subcmd(jc, SUB_IMU_ENABLE, &a, 1); break;
    case STEP_VIBRATION:   a = 0x01; jc_subcmd(jc, SUB_VIBRATION, &a, 1); break;
    case STEP_REPORT_MODE: a = 0x30; jc_subcmd(jc, SUB_REPORT_MODE, &a, 1); break;
    case STEP_PLAYER_LEDS: a = jc->leds ? jc->leds : 0x01; jc_subcmd(jc, SUB_PLAYER_LEDS, &a, 1); break;
    default: break;
    }
}

static void advance_step(joycon_t *jc)
{
    jc->step++;
    jc->tries = 0;
    jc->step_ticks = SUBCMD_RETRY_TICKS; /* send the next one right away */
}

static void start_init(joycon_t *jc)
{
    jc->step = STEP_DEVICE_INFO;
    jc->tries = 0;
    jc->step_ticks = 0;
    jc->type = JC_TYPE_RIGHT;
    set_state(jc, JS_INIT);
}

static int jc_custom_resume(void *usrdata, fake_wiimote_t *wiimote);
static int jc_custom_suspend(void *usrdata);
static int jc_custom_set_leds(void *usrdata, int leds);
static int jc_custom_set_rumble(void *usrdata, bool rumble_on);
static bool jc_custom_report_input(void *usrdata);

static const input_device_ops_t joycon_input_ops = {
    .resume = jc_custom_resume,
    .suspend = jc_custom_suspend,
    .set_leds = jc_custom_set_leds,
    .set_rumble = jc_custom_set_rumble,
    .report_input = jc_custom_report_input,
};

static void become_ready(joycon_t *jc)
{
    set_state(jc, JS_READY);
    jc->input_age = 0;
    bm_ir_emulation_state_reset(&jc->ir_state);
    if (!jc->input_device)
        jc->input_device = input_device_add_custom(&joycon_input_ops, jc);
}

static void run_init(joycon_t *jc)
{
    if (jc->state_ticks < INIT_DELAY_TICKS)
        return;
    if (jc->step >= STEP_DONE) {
        become_ready(jc);
        return;
    }
    if (++jc->step_ticks >= SUBCMD_RETRY_TICKS) {
        if (jc->tries >= SUBCMD_MAX_TRIES) {
            advance_step(jc); /* carry on with defaults */
            return;
        }
        send_step(jc);
        jc->tries++;
        jc->step_ticks = 0;
    }
}

static void handle_report(joycon_t *jc, const u8 *d, u16 len)
{
    if (len < 13)
        return;
    if (d[0] != 0x21 && d[0] != 0x30)
        return;

    jc->buttons = d[3] | (d[4] << 8) | (d[5] << 16);
    const u8 *s = (jc->type == JC_TYPE_LEFT) ? d + 6 : d + 9;
    jc->stick_x = s[0] | ((s[1] & 0x0F) << 8);
    jc->stick_y = (s[1] >> 4) | (s[2] << 4);
    jc->input_age = 0;

    if (d[0] == 0x30 && len >= 49) {
        const u8 *imu = d + 13 + 24; /* newest of the 3 samples */
        jc->acc[0] = (s16)(imu[0] | (imu[1] << 8));
        jc->acc[1] = (s16)(imu[2] | (imu[3] << 8));
        jc->acc[2] = (s16)(imu[4] | (imu[5] << 8));
    }

    if (d[0] == 0x21 && len >= 15 && jc->state == JS_INIT && (d[13] & 0x80)) {
        u8 sub = d[14];
        static const u8 expect[STEP_DONE] = {
            SUB_DEVICE_INFO, SUB_IMU_ENABLE, SUB_VIBRATION, SUB_REPORT_MODE, SUB_PLAYER_LEDS
        };
        if (jc->step < STEP_DONE && sub == expect[jc->step]) {
            if (sub == SUB_DEVICE_INFO && len >= 18 && d[17] >= 1 && d[17] <= 3)
                jc->type = d[17];
            advance_step(jc);
        }
    }
}

void joycon_bt_handle_acl(u16 con_handle, const u8 *data, u16 len)
{
    joycon_t *jc = find_by_handle(con_handle);
    if (!jc || len < 4)
        return;
    u16 l2len = get16(data);
    u16 cid = get16(data + 2);
    const u8 *p = data + 4;
    if (l2len + 4 > len)
        l2len = len - 4;

    if (cid == CID_SIGNAL) {
        handle_signal(jc, p, l2len);
    } else if (jc->intr.local_cid && cid == jc->intr.local_cid) {
        if (l2len >= 2 && p[0] == 0xA1)
            handle_report(jc, p + 1, l2len - 1);
    }
    /* control channel: HIDP handshakes, ignored */
}

/* ------------------------------------------------------------------------ */
/* HCI events / commands                                                    */
/* ------------------------------------------------------------------------ */

static void send_auth(joycon_t *jc)
{
    u8 p[2] = { jc->handle & 0xFF, jc->handle >> 8 };
    bt_host_send_cmd(HCI_CMD_AUTH_REQ, p, 2);
}

bool joycon_bt_handle_event(u8 event, const u8 *p, u8 len)
{
    joycon_t *jc;

    switch (event) {
    case HCI_EVENT_CON_REQ: /* bdaddr(6) class(3) link_type(1) */
        if (len < 10 || !(jc = find_by_addr(p)))
            return false;
        if (jc->state == JS_IDLE || jc->state == JS_PAGING) {
            u8 a[7];
            memcpy(a, p, 6);
            a[6] = 0x00; /* stay master: the Wii is master for its Wii Remotes */
            bt_host_send_cmd(HCI_CMD_ACCEPT_CON, a, 7);
            jc->we_initiated = false;
            set_state(jc, JS_PAGING);
        }
        return true;

    case HCI_EVENT_CON_COMPL: /* status handle(2) bdaddr(6) link_type encr */
        if (len < 11 || !(jc = find_by_addr(p + 3)))
            return false;
        if (p[0] == 0 && p[9] == 0x01 /* ACL */) {
            jc->handle = HCI_CON_HANDLE(get16(p + 1));
            memset(&jc->ctrl, 0, sizeof(jc->ctrl));
            memset(&jc->intr, 0, sizeof(jc->intr));
            set_state(jc, JS_LINKED);
            if (jc->we_initiated)
                send_auth(jc);
        } else if (jc->state == JS_PAGING) {
            reset_link(jc);
        }
        return true;

    case HCI_EVENT_LINK_KEY_REQ: /* bdaddr */
        if (len < 6 || !(jc = find_by_addr(p)))
            return false;
        if (jc->have_key) {
            u8 r[22];
            memcpy(r, p, 6);
            memcpy(r + 6, jc->key, 16);
            bt_host_send_cmd(HCI_CMD_LINK_KEY_REP, r, 22);
        } else {
            bt_host_send_cmd(HCI_CMD_LINK_KEY_NEG_REP, p, 6);
        }
        return true;

    case HCI_EVENT_PIN_CODE_REQ: { /* bdaddr */
        if (len < 6 || !(jc = find_by_addr(p)))
            return false;
        u8 r[23];
        memset(r, 0, sizeof(r));
        memcpy(r, p, 6);
        r[6] = 6;
        memcpy(r + 7, bt_host_local_bdaddr(), 6); /* same PIN libogc uses */
        bt_host_send_cmd(HCI_CMD_PIN_CODE_REP, r, 23);
        return true;
    }

    case HCI_EVENT_LINK_KEY_NOTIFICATION: /* bdaddr key(16) type */
        if (len < 22 || !(jc = find_by_addr(p)))
            return false;
        memcpy(jc->key, p + 6, 16);
        jc->have_key = true;
        return true;

    case HCI_EVENT_AUTH_COMPL: /* status handle */
        if (len < 3 || !(jc = find_by_handle(HCI_CON_HANDLE(get16(p + 1)))))
            return false;
        if (!jc->auth_done) {
            jc->auth_done = true;
            if (jc->we_initiated && !jc->ctrl.local_cid)
                l2cap_connect(jc, &jc->ctrl, PSM_HID_CTRL, 0x0040);
        }
        return true;

    case HCI_EVENT_DISCON_COMPL: /* status handle reason */
        if (len < 4 || !(jc = find_by_handle(HCI_CON_HANDLE(get16(p + 1)))))
            return false;
        if (p[0] == 0)
            reset_link(jc);
        return true;

    case HCI_EVENT_ROLE_CHANGE:              /* status bdaddr role */
        return len >= 7 && find_by_addr(p + 1);
    case HCI_EVENT_PAGE_SCAN_REP_MODE_CHANGE: /* bdaddr mode */
    case HCI_EVENT_PAGE_SCAN_MODE_CHANGE:
        return len >= 6 && find_by_addr(p);

    /* status + handle */
    case HCI_EVENT_ENCRYPTION_CHANGE:
    case HCI_EVENT_CHANGE_CON_LINK_KEY_COMPL:
    case HCI_EVENT_READ_REMOTE_FEATURES_COMPL:
    case HCI_EVENT_READ_REMOTE_VER_INFO_COMPL:
    case HCI_EVENT_QOS_SETUP_COMPL:
    case HCI_EVENT_MODE_CHANGE:
    case HCI_EVENT_READ_CLOCK_OFFSET_COMPL:
    case HCI_EVENT_CON_PKT_TYPE_CHANGED:
    case HCI_EVENT_READ_REMOTE_EXTENDED_FEATURES:
    case HCI_EVENT_SNIFF_SUBRATING:
    case HCI_EVENT_ENCRYPTION_KEY_REFRESH:
        return len >= 3 && find_by_handle(HCI_CON_HANDLE(get16(p + 1)));

    /* handle only */
    case HCI_EVENT_FLUSH_OCCUR:
    case HCI_EVENT_MAX_SLOT_CHANGE:
    case HCI_EVENT_QOS_VIOLATION:
    case HCI_EVENT_LINK_SUPERVISION_TO_CHANGED:
    case HCI_EVENT_ENHANCED_FLUSH_COMPL:
        return len >= 2 && find_by_handle(HCI_CON_HANDLE(get16(p)));

    default:
        return false;
    }
}

void joycon_bt_cmd_done(u16 opcode, u8 status, const u8 *params, u8 len)
{
    UNUSED(params);
    UNUSED(len);
    if ((opcode == HCI_CMD_CREATE_CON || opcode == HCI_CMD_ACCEPT_CON) && status != 0) {
        for (int i = 0; i < JOYCON_MAX_ADDRS; i++)
            if (joycons[i].state == JS_PAGING)
                reset_link(&joycons[i]);
    }
    if (opcode == HCI_CMD_AUTH_REQ && status != 0) {
        /* Authentication not possible: try L2CAP anyway */
        for (int i = 0; i < JOYCON_MAX_ADDRS; i++) {
            joycon_t *jc = &joycons[i];
            if (jc->state == JS_LINKED && !jc->auth_done) {
                jc->auth_done = true;
                if (jc->we_initiated && !jc->ctrl.local_cid)
                    l2cap_connect(jc, &jc->ctrl, PSM_HID_CTRL, 0x0040);
            }
        }
    }
}

void joycon_bt_reset_all(void)
{
    for (int i = 0; i < JOYCON_MAX_ADDRS; i++)
        if (joycons[i].state != JS_UNUSED)
            reset_link(&joycons[i]);
}

void joycon_bt_cmd_failed(u16 opcode)
{
    joycon_bt_cmd_done(opcode, 0xFF, NULL, 0);
}

static void start_page(joycon_t *jc)
{
    u8 p[13];
    memcpy(p, jc->addr, 6);
    put16(p + 6, 0xCC18); /* DM1 DH1 DM3 DH3 DM5 DH5 */
    p[8] = 0x01;          /* page scan repetition mode R1 */
    p[9] = 0x00;
    put16(p + 10, 0x0000);/* clock offset unknown */
    p[12] = 0x00;         /* no role switch: the Wii stays master */
    if (bt_host_send_cmd(HCI_CMD_CREATE_CON, p, sizeof(p))) {
        jc->we_initiated = true;
        set_state(jc, JS_PAGING);
    }
}

void joycon_bt_tick(void)
{
    bool paging = false;

    bt_host_tick();

    if (global_page_cooldown)
        global_page_cooldown--;

    for (int i = 0; i < JOYCON_MAX_ADDRS; i++)
        if (joycons[i].state == JS_PAGING)
            paging = true;

    for (int i = 0; i < JOYCON_MAX_ADDRS; i++) {
        joycon_t *jc = &joycons[i];
        jc->state_ticks++;

        switch (jc->state) {
        case JS_IDLE:
            jc->idle_ticks++;
            if (!paging && !global_page_cooldown && jc->idle_ticks >= PAGE_RETRY_TICKS &&
                bt_host_ready() && hci_can_request_connection()) {
                start_page(jc);
                paging = true;
                global_page_cooldown = TICKS_PER_SEC / 2;
            }
            break;
        case JS_PAGING:
            if (jc->state_ticks > CONNECT_TIMEOUT)
                reset_link(jc);
            break;
        case JS_LINKED:
            if (jc->state_ticks > CONNECT_TIMEOUT)
                hci_disconnect(jc);
            break;
        case JS_INIT:
            run_init(jc);
            break;
        case JS_READY:
            if (++jc->input_age > INPUT_TIMEOUT_TICKS)
                hci_disconnect(jc);
            break;
        case JS_DISCONNECTING:
            if (jc->state_ticks > 2 * TICKS_PER_SEC)
                reset_link(jc);
            break;
        default:
            break;
        }
    }
}

/* ------------------------------------------------------------------------ */
/* Input device ops: Joy-Con -> fake Wii Remote                             */
/* ------------------------------------------------------------------------ */

static int jc_custom_resume(void *usrdata, fake_wiimote_t *wiimote)
{
    UNUSED(usrdata);
    UNUSED(wiimote);
    return 0;
}

static int jc_custom_suspend(void *usrdata)
{
    UNUSED(usrdata);
    return 0;
}

static int jc_custom_set_leds(void *usrdata, int leds)
{
    joycon_t *jc = usrdata;
    u8 a = leds & 0x0F;
    jc->leds = a;
    if (jc->state == JS_READY)
        jc_subcmd(jc, SUB_PLAYER_LEDS, &a, 1);
    return 0;
}

static int jc_custom_set_rumble(void *usrdata, bool rumble_on)
{
    joycon_t *jc = usrdata;
    if (jc->rumble != rumble_on) {
        jc->rumble = rumble_on;
        if (jc->state == JS_READY)
            jc_send_rumble(jc);
    }
    return 0;
}

/* stick raw (0..4095) -> -1000..1000 with dead zone */
static int stick_norm(u16 raw)
{
    int v = ((int)raw - 2048) * 1000 / 1400;
    if (v > 1000)
        v = 1000;
    if (v < -1000)
        v = -1000;
    if (v > -150 && v < 150)
        v = 0;
    return v;
}

static u16 acc_to_wiimote(int jc_raw)
{
    int v = ACCEL_ZERO_G + jc_raw * WM_ACC_PER_G / 4096;
    if (v < 0)
        v = 0;
    if (v > 1023)
        v = 1023;
    return v;
}

static bool jc_custom_report_input(void *usrdata)
{
    joycon_t *jc = usrdata;
    fake_wiimote_t *wiimote = input_device_get_wiimote(jc->input_device);
    u32 b = jc->buttons;
    u16 wb = 0;
    int sx = stick_norm(jc->stick_x);
    int sy = stick_norm(jc->stick_y);
    bool dpad_mode;
    struct ir_dot_t ir_dots[IR_MAX_DOTS];

    if (!wiimote)
        return false;

    if (jc->type == JC_TYPE_LEFT) {
        /* Joy-Con (L) held upright like a Wii Remote */
        if (b & JB_RIGHT) wb |= WIIMOTE_BUTTON_A;
        if (b & (JB_ZL | JB_L)) wb |= WIIMOTE_BUTTON_B;
        if (b & (JB_DOWN | JB_L_SL)) wb |= WIIMOTE_BUTTON_ONE;
        if (b & (JB_LEFT | JB_L_SR)) wb |= WIIMOTE_BUTTON_TWO;
        if (b & JB_UP) wb |= WIIMOTE_BUTTON_PLUS;
        if (b & JB_MINUS) wb |= WIIMOTE_BUTTON_MINUS;
        if (b & JB_CAPTURE) wb |= WIIMOTE_BUTTON_HOME;
        dpad_mode = (b & JB_LSTICK) != 0;
    } else {
        /* Joy-Con (R) (and Pro Controller) */
        if (b & JB_A) wb |= WIIMOTE_BUTTON_A;
        if (b & (JB_ZR | JB_R)) wb |= WIIMOTE_BUTTON_B;
        if (b & (JB_Y | JB_R_SL)) wb |= WIIMOTE_BUTTON_ONE;
        if (b & (JB_B | JB_R_SR)) wb |= WIIMOTE_BUTTON_TWO;
        if (b & JB_PLUS) wb |= WIIMOTE_BUTTON_PLUS;
        if (b & (JB_X | JB_MINUS)) wb |= WIIMOTE_BUTTON_MINUS;
        if (b & JB_HOME) wb |= WIIMOTE_BUTTON_HOME;
        dpad_mode = (b & JB_RSTICK) != 0;
    }

    /* Stick: IR pointer, or D-pad while the stick is pressed in */
    s16 axes[2] = { 0, 0 };
    if (dpad_mode) {
        if (sy > 500) wb |= WIIMOTE_BUTTON_UP;
        if (sy < -500) wb |= WIIMOTE_BUTTON_DOWN;
        if (sx < -500) wb |= WIIMOTE_BUTTON_LEFT;
        if (sx > 500) wb |= WIIMOTE_BUTTON_RIGHT;
    } else {
        axes[0] = sx * 80 / 1000;
        axes[1] = sy * 80 / 1000;
    }
    static const u8 ir_map[2] = { BM_IR_AXIS_X, BM_IR_AXIS_Y };
    bm_map_ir_analog_axis(BM_IR_EMULATION_MODE_RELATIVE_ANALOG_AXIS, &jc->ir_state, 2, axes,
                          ir_map, ir_dots);
    fake_wiimote_report_ir_dots(wiimote, ir_dots);

    /* Accelerometer: sensor frame -> (right, forward, up) as verified with the
     * Joy-Con Bridge app, then to the Wii Remote's axes (+X = left). */
    int right, fwd, up;
    if (jc->type == JC_TYPE_RIGHT) {
        right = jc->acc[1];
        fwd = jc->acc[0];
        up = -jc->acc[2];
    } else {
        right = -jc->acc[1];
        fwd = jc->acc[0];
        up = jc->acc[2];
    }
    fake_wiimote_report_accelerometer(wiimote, acc_to_wiimote(-right), acc_to_wiimote(fwd),
                                      acc_to_wiimote(up));

    fake_wiimote_report_input(wiimote, wb);
    return true;
}
