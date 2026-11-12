/*
 * bt_host.c - module-originated Bluetooth traffic for fakemote
 *
 * The game owns the Wii's Bluetooth controller through /dev/usb/oh1. This
 * file adds a second, hidden "host" next to it:
 *
 *  - HCI commands and ACL packets are injected as extra USB requests that
 *    are handed down to the OH1 driver (see main.c), one HCI command at a
 *    time and only while the game has no command outstanding.
 *  - Every HCI event and incoming ACL packet passes through
 *    bt_host_filter_hci_event() / bt_host_filter_acl_in() first. Anything
 *    that belongs to one of our connections (or answers one of our commands)
 *    is consumed here and never reaches the game.
 */
#include <string.h>

#include "bt_host.h"
#include "hci.h"
#include "joycon_bt.h"
#include "syscalls.h"
#include "utils.h"

/* USBV0 ioctls / endpoints (see main.c) */
#define USBV0_IOCTLV_CTRLMSG 0
#define USBV0_IOCTLV_BLKMSG  1
#define EP_ACL_DATA_OUT      0x02

#define CMD_QUEUE_LEN 8
#define ACL_SLOTS     8
#define ACL_MAX_LEN   128
#define CMD_MAX_LEN   (3 + 255)

/* Cancel our command if the controller never answers (~2 s @ 5 ms ticks) */
#define CMD_TIMEOUT_TICKS 400

static int oh1_fd = -1;
static u8 local_bdaddr[6];
static bool local_bdaddr_valid;

/* Game command flow control */
static bool game_cmd_outstanding;

/* ---- HCI command path ---- */

static struct {
    u16 opcode;
    u8 len;
    u8 params[255];
} cmd_queue[CMD_QUEUE_LEN];
static int cmd_head, cmd_count;

static u16 cmd_outstanding_opcode; /* 0 = none */
static u32 cmd_outstanding_ticks;
static bool cmd_msg_busy; /* the ipcmessage is with OH1 */
static bool cmd_msg_ready;

static u8 cmd_buf[CMD_MAX_LEN] ATTRIBUTE_ALIGN(32);
static u8 cmd_bmRequestType ATTRIBUTE_ALIGN(32);
static u8 cmd_bRequest ATTRIBUTE_ALIGN(32);
static u16 cmd_wValue ATTRIBUTE_ALIGN(32);
static u16 cmd_wIndex ATTRIBUTE_ALIGN(32);
static u16 cmd_wLength ATTRIBUTE_ALIGN(32);
static u8 cmd_unknown ATTRIBUTE_ALIGN(32);
static ioctlv cmd_vec[7];
static ipcmessage cmd_msg;

/* ---- ACL out path ---- */

static struct {
    bool used;  /* filled, waiting or with OH1 */
    bool queued; /* ready to be handed down */
    u8 ep;
    u16 wLength;
    ioctlv vec[3];
    ipcmessage msg;
    u8 data[ACL_MAX_LEN] ATTRIBUTE_ALIGN(32);
} acl_slots[ACL_SLOTS] ATTRIBUTE_ALIGN(32);

void bt_host_init(void)
{
    oh1_fd = -1;
    local_bdaddr_valid = false;
    game_cmd_outstanding = false;
    cmd_head = cmd_count = 0;
    cmd_outstanding_opcode = 0;
    cmd_msg_busy = cmd_msg_ready = false;
    memset(acl_slots, 0, sizeof(acl_slots));
}

void bt_host_set_fd(int fd)
{
    oh1_fd = fd;
}

bool bt_host_ready(void)
{
    return oh1_fd >= 0 && local_bdaddr_valid;
}

const u8 *bt_host_local_bdaddr(void)
{
    return local_bdaddr;
}

bool bt_host_send_cmd(u16 opcode, const void *params, u8 len)
{
    if (cmd_count >= CMD_QUEUE_LEN)
        return false;
    int idx = (cmd_head + cmd_count) % CMD_QUEUE_LEN;
    cmd_queue[idx].opcode = opcode;
    cmd_queue[idx].len = len;
    if (len)
        memcpy(cmd_queue[idx].params, params, len);
    cmd_count++;
    return true;
}

bool bt_host_send_acl(u16 con_handle, const void *data, u16 len)
{
    if (len + 4 > ACL_MAX_LEN)
        return false;
    for (int i = 0; i < ACL_SLOTS; i++) {
        if (acl_slots[i].used)
            continue;
        u8 *p = acl_slots[i].data;
        u16 h = HCI_MK_CON_HANDLE(con_handle, HCI_PACKET_START, HCI_POINT2POINT);
        p[0] = h & 0xFF;
        p[1] = h >> 8;
        p[2] = len & 0xFF;
        p[3] = len >> 8;
        memcpy(p + 4, data, len);
        acl_slots[i].used = true;
        acl_slots[i].queued = true;
        acl_slots[i].wLength = len + 4;
        return true;
    }
    return false;
}

static ipcmessage *prepare_cmd_msg(void)
{
    int idx = cmd_head;
    u16 opcode = cmd_queue[idx].opcode;
    u8 len = cmd_queue[idx].len;

    cmd_buf[0] = opcode & 0xFF;
    cmd_buf[1] = opcode >> 8;
    cmd_buf[2] = len;
    memcpy(cmd_buf + 3, cmd_queue[idx].params, len);
    cmd_head = (cmd_head + 1) % CMD_QUEUE_LEN;
    cmd_count--;

    cmd_bmRequestType = 0x20; /* class request, host to device */
    cmd_bRequest = 0;         /* EP_HCI_CTRL */
    cmd_wValue = 0;
    cmd_wIndex = 0;
    cmd_wLength = htole16(len + 3);
    cmd_unknown = 0;

    cmd_vec[0] = (ioctlv){ &cmd_bmRequestType, 1 };
    cmd_vec[1] = (ioctlv){ &cmd_bRequest, 1 };
    cmd_vec[2] = (ioctlv){ &cmd_wValue, 2 };
    cmd_vec[3] = (ioctlv){ &cmd_wIndex, 2 };
    cmd_vec[4] = (ioctlv){ &cmd_wLength, 2 };
    cmd_vec[5] = (ioctlv){ &cmd_unknown, 1 };
    cmd_vec[6] = (ioctlv){ cmd_buf, len + 3 };

    memset(&cmd_msg, 0, sizeof(cmd_msg));
    cmd_msg.command = IOS_IOCTLV;
    cmd_msg.fd = oh1_fd;
    cmd_msg.ioctlv.command = USBV0_IOCTLV_CTRLMSG;
    cmd_msg.ioctlv.num_in = 6;
    cmd_msg.ioctlv.num_io = 1;
    cmd_msg.ioctlv.vector = cmd_vec;

    os_sync_after_write(cmd_buf, len + 3);
    os_sync_after_write(&cmd_bmRequestType, 1);
    os_sync_after_write(&cmd_bRequest, 1);
    os_sync_after_write(&cmd_wValue, 2);
    os_sync_after_write(&cmd_wIndex, 2);
    os_sync_after_write(&cmd_wLength, 2);
    os_sync_after_write(&cmd_unknown, 1);

    cmd_outstanding_opcode = opcode;
    cmd_outstanding_ticks = 0;
    cmd_msg_busy = true;
    return &cmd_msg;
}

static ipcmessage *prepare_acl_msg(int i)
{
    acl_slots[i].queued = false;
    acl_slots[i].ep = EP_ACL_DATA_OUT;
    acl_slots[i].vec[0] = (ioctlv){ &acl_slots[i].ep, 1 };
    acl_slots[i].vec[1] = (ioctlv){ &acl_slots[i].wLength, 2 };
    acl_slots[i].vec[2] = (ioctlv){ acl_slots[i].data, acl_slots[i].wLength };

    memset(&acl_slots[i].msg, 0, sizeof(acl_slots[i].msg));
    acl_slots[i].msg.command = IOS_IOCTLV;
    acl_slots[i].msg.fd = oh1_fd;
    acl_slots[i].msg.ioctlv.command = USBV0_IOCTLV_BLKMSG;
    acl_slots[i].msg.ioctlv.num_in = 2;
    acl_slots[i].msg.ioctlv.num_io = 1;
    acl_slots[i].msg.ioctlv.vector = acl_slots[i].vec;

    os_sync_after_write(acl_slots[i].data, acl_slots[i].wLength);
    os_sync_after_write(&acl_slots[i].ep, 1);
    os_sync_after_write(&acl_slots[i].wLength, 2);
    return &acl_slots[i].msg;
}

ipcmessage *bt_host_next_outgoing(void)
{
    if (oh1_fd < 0)
        return NULL;

    /* ACL data first: it never interferes with HCI command flow control */
    for (int i = 0; i < ACL_SLOTS; i++) {
        if (acl_slots[i].used && acl_slots[i].queued)
            return prepare_acl_msg(i);
    }

    /* One HCI command at a time, never while the game waits for one */
    if (cmd_count > 0 && !cmd_outstanding_opcode && !cmd_msg_busy && !game_cmd_outstanding)
        return prepare_cmd_msg();

    return NULL;
}

bool bt_host_handle_reply(ipcmessage *msg, int retval)
{
    if (msg == &cmd_msg) {
        cmd_msg_busy = false;
        if (retval < 0) {
            /* USB transfer failed: the controller never saw the command */
            cmd_outstanding_opcode = 0;
        }
        return true;
    }
    for (int i = 0; i < ACL_SLOTS; i++) {
        if (msg == &acl_slots[i].msg) {
            acl_slots[i].used = false;
            return true;
        }
    }
    return false;
}

void bt_host_snoop_hci_cmd_from_host(const u8 *data, u32 length)
{
    game_cmd_outstanding = true;
    if (length >= 2 && (data[0] | (data[1] << 8)) == HCI_CMD_RESET) {
        /* The controller drops every connection on reset */
        cmd_head = cmd_count = 0;
        cmd_outstanding_opcode = 0;
        joycon_bt_reset_all();
    }
}

/* Called from the periodic timer through joycon_bt_tick() */
void bt_host_tick(void)
{
    if (cmd_outstanding_opcode && ++cmd_outstanding_ticks > CMD_TIMEOUT_TICKS) {
        joycon_bt_cmd_failed(cmd_outstanding_opcode);
        cmd_outstanding_opcode = 0;
    }
}

/* Remove our connection handles from a Number Of Completed Packets event.
 * Returns true if no entry is left (event must be dropped). */
static bool strip_num_compl_pkts(u8 *params, u8 *plen)
{
    u8 n = params[0];
    u8 out = 0;
    for (u8 i = 0; i < n; i++) {
        u8 *e = params + 1 + i * 4;
        u16 h = HCI_CON_HANDLE(e[0] | (e[1] << 8));
        if (joycon_bt_owns_handle(h))
            continue;
        if (out != i)
            memmove(params + 1 + out * 4, e, 4);
        out++;
    }
    if (out == n)
        return false;
    params[0] = out;
    *plen = 1 + out * 4;
    return out == 0;
}

bool bt_host_filter_hci_event(u8 *data, u32 length)
{
    if (length < 2)
        return false;
    u8 event = data[0];
    u8 plen = data[1];
    u8 *p = data + 2;

    switch (event) {
    case HCI_EVENT_COMMAND_COMPL:
    case HCI_EVENT_COMMAND_STATUS: {
        /* COMMAND_COMPL: ncmd, opcode, return params
         * COMMAND_STATUS: status, ncmd, opcode */
        u16 opcode = (event == HCI_EVENT_COMMAND_COMPL) ? (p[1] | (p[2] << 8))
                                                        : (p[2] | (p[3] << 8));
        if (event == HCI_EVENT_COMMAND_COMPL && opcode == HCI_CMD_READ_BDADDR && p[3] == 0) {
            memcpy(local_bdaddr, p + 4, 6);
            local_bdaddr_valid = true;
        }
        if (cmd_outstanding_opcode && opcode == cmd_outstanding_opcode) {
            u8 status = (event == HCI_EVENT_COMMAND_COMPL) ? p[3] : p[0];
            cmd_outstanding_opcode = 0;
            joycon_bt_cmd_done(opcode, status, p, plen);
            return true;
        }
        if (opcode != 0)
            game_cmd_outstanding = false;
        return false;
    }
    case HCI_EVENT_NUM_COMPL_PKTS:
        if (strip_num_compl_pkts(p, &data[1])) {
            return true;
        }
        if (data[1] != plen)
            os_sync_after_write(data, 2 + data[1]);
        return false;
    default:
        break;
    }

    if (joycon_bt_handle_event(event, p, plen))
        return true;
    return false;
}

bool bt_host_filter_acl_in(u8 *data, u32 length)
{
    if (length < 4)
        return false;
    u16 hf = data[0] | (data[1] << 8);
    u16 h = HCI_CON_HANDLE(hf);
    if (!joycon_bt_owns_handle(h))
        return false;
    u16 len = data[2] | (data[3] << 8);
    if (len + 4 > length)
        len = length - 4;
    /* Continuation fragments are not expected for Joy-Con reports (< 64 bytes) */
    if (HCI_PB_FLAG(hf) == HCI_PACKET_START || HCI_PB_FLAG(hf) == 0)
        joycon_bt_handle_acl(h, data + 4, len);
    return true;
}
