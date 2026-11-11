/*
 * joycon.c - Nintendo Switch Joy-Con / Pro Controller driver for Wii homebrew
 *
 * Protocol reference: dekuNukem/Nintendo_Switch_Reverse_Engineering and the
 * Linux hid-nintendo driver.
 *
 * Threading model
 * ---------------
 * All BTE callbacks (receive, connect, disconnect, inquiry, remote name) are
 * invoked from the Bluetooth IPC callback, i.e. in interrupt context. They
 * only copy raw bytes and set flags - no floating point, no allocation.
 * Everything else (parsing, calibration, the connect state machine) runs in
 * JC_Update() on the main thread.
 */
#include <gccore.h>
#include <ogc/machine/processor.h>
#include <ogc/lwp_watchdog.h>
#include <bte/bte.h>
#include <wiiuse/wpad.h>

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "joycon.h"

/* ------------------------------------------------------------------------ */
/* Constants                                                                */
/* ------------------------------------------------------------------------ */

#define RX_RING_SIZE      16
#define RX_PKT_MAX        64
#define OUT_REPORT_LEN    49     /* 0x01 / 0x10 output reports, padded      */

#define MAX_CANDIDATES    8

#define CONNECT_TIMEOUT_MS   15000
#define NAME_TIMEOUT_MS       5000
#define SUBCMD_RETRY_MS        300
#define SUBCMD_MAX_TRIES         6
#define INIT_DELAY_MS          150
#define CALIB_SAMPLES          200   /* 3 samples per report @ ~66 Hz = ~1 s */
#define CALIB_MAX_MOTION_DPS  12.0f
#define IMU_SAMPLE_DT        0.005f  /* IMU runs at 200 Hz                   */

#define MP_COUNTS_PER_DPS_SLOW 20.0f
#define MP_COUNTS_PER_DPS_FAST (20.0f / 4.54f)

/* Subcommands */
#define SUB_DEVICE_INFO    0x02
#define SUB_REPORT_MODE    0x03
#define SUB_SPI_READ       0x10
#define SUB_PLAYER_LEDS    0x30
#define SUB_IMU_ENABLE     0x40
#define SUB_VIBRATION      0x48

/* SPI flash addresses */
#define SPI_FACTORY_IMU    0x6020
#define SPI_FACTORY_STICK  0x603D
#define SPI_USER_STICK     0x8010
#define SPI_USER_IMU       0x8026

static const u8 RUMBLE_OFF[4] = { 0x00, 0x01, 0x40, 0x40 };
/* 320 Hz / 160 Hz, amplitude ~0.6 (encoding per dekuNukem rumble notes)     */
static const u8 RUMBLE_ON[4]  = { 0x00, 0x99, 0x40, 0x66 };

/* ------------------------------------------------------------------------ */
/* Axis mapping                                                             */
/* ------------------------------------------------------------------------ */
/*
 * Each entry selects the source axis (1 = x, 2 = y, 3 = z of the calibrated
 * sensor vector) and its sign for the output axis x (right), y (forward),
 * z (up) of the Wii Remote frame. Can be changed at runtime with
 * JC_SetAxisMap() (the demo app has a 2-step wizard for that).
 *
 * Joy-Con (R)'s IMU is mounted rotated by 180 deg around the long axis
 * relative to Joy-Con (L), hence y and z are flipped.
 */
static s8 axis_map[4][3] = {
	/* UNKNOWN */ { -2, +1, +3 },
	/* LEFT    */ { -2, +1, +3 },
	/* RIGHT   */ { +2, +1, -3 },
	/* PRO     */ { -2, +1, +3 },
};

/* ------------------------------------------------------------------------ */
/* Types                                                                    */
/* ------------------------------------------------------------------------ */

typedef struct {
	u8 len;
	u8 data[RX_PKT_MAX];
} rx_pkt_t;

typedef struct {
	u16 center[2];
	u16 above[2];   /* max distance above center */
	u16 below[2];   /* max distance below center */
} stick_cal_t;

typedef enum {
	STEP_DEVICE_INFO = 0,
	STEP_SPI_FACTORY_IMU,
	STEP_SPI_FACTORY_STICK,
	STEP_SPI_USER_STICK,
	STEP_SPI_USER_IMU,
	STEP_IMU_ENABLE,
	STEP_VIBRATION,
	STEP_REPORT_MODE,
	STEP_PLAYER_LEDS,
	STEP_DONE
} init_step_t;

typedef struct {
	jc_state_t pub;

	/* connection - touched from IRQ context */
	struct bte_pcb *sock;
	struct bd_addr addr;
	volatile u8 ev_connected;
	volatile u8 ev_failed;
	volatile u8 ev_disconnected;

	/* receive ring - written in IRQ, read in JC_Update() */
	rx_pkt_t ring[RX_RING_SIZE];
	volatile u32 ring_w;
	u32 ring_r;

	u64 t_state;           /* time the current status was entered        */

	/* init sequence */
	init_step_t step;
	int tries;
	u64 t_cmd;
	u8 pkt_counter;

	/* calibration */
	s16 acc_origin[3], acc_sens[3];
	s16 gyro_origin[3], gyro_sens[3];
	stick_cal_t lcal, rcal;

	float bias[3];
	float calib_sum[3];
	int calib_n;
	bool have_orientation;

	/* rumble */
	u64 rumble_until;
	bool rumble_active;

	u32 prev_buttons;
	u32 rate_count;
	u64 t_rate;
} jc_t;

/* ------------------------------------------------------------------------ */
/* Globals                                                                  */
/* ------------------------------------------------------------------------ */

static jc_t pads[JC_MAX_CONTROLLERS];
static bool jc_inited = false;

/* scanning */
static jc_scan_t scan_state = JC_SCAN_OFF;
static bool scan_wanted = false;
static u64 t_scan;
static volatile u8 ev_inquiry_done;
static volatile u8 ev_name_done;
static volatile s32 name_result;
static struct inquiry_info_ex cand[MAX_CANDIDATES];
static volatile int cand_n;
static int cand_idx;
static struct pad_name_info name_info;
static int connecting_slot = -1;

/* log */
#define LOG_LINES 6
#define LOG_LEN   60
static char log_buf[LOG_LINES][LOG_LEN];
static int log_head = 0;

static void jc_log(const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(log_buf[log_head], LOG_LEN, fmt, ap);
	va_end(ap);
	log_head = (log_head + 1) % LOG_LINES;
}

int JC_GetLog(const char **lines, int max)
{
	int n = 0;
	for (int i = 0; i < LOG_LINES && n < max; i++) {
		const char *l = log_buf[(log_head + i) % LOG_LINES];
		if (l[0]) lines[n++] = l;
	}
	return n;
}

static inline u32 ms_since(u64 t)
{
	return diff_msec(t, gettime());
}

static inline s16 rd_s16(const u8 *p) { return (s16)(p[0] | (p[1] << 8)); }

static void addr_to_bytes(u8 out[6], const struct bd_addr *a)
{
	/* bd_addr is stored little endian; present it in the usual order */
	for (int i = 0; i < 6; i++) out[i] = a->addr[5 - i];
}

/* ------------------------------------------------------------------------ */
/* IRQ-context callbacks                                                    */
/* ------------------------------------------------------------------------ */

static s32 cb_receive(void *arg, void *buffer, u16 len)
{
	jc_t *c = (jc_t *)arg;
	if (!c || !buffer || !len) return ERR_OK;

	rx_pkt_t *p = &c->ring[c->ring_w % RX_RING_SIZE];
	if (len > RX_PKT_MAX) len = RX_PKT_MAX;
	memcpy(p->data, buffer, len);
	p->len = (u8)len;
	c->ring_w++;
	return ERR_OK;
}

static s32 cb_disconnected(void *arg, struct bte_pcb *pcb, u8 err)
{
	jc_t *c = (jc_t *)arg;
	if (!c) return ERR_OK;
	if (c->sock == pcb) {
		/* same ownership rule as wiiuse: the remote side closed the link,
		 * so we release the pcb here */
		bte_free(pcb);
		c->sock = NULL;
	}
	c->ev_disconnected = 1;
	return ERR_OK;
}

static s32 cb_connected(void *arg, struct bte_pcb *pcb, u8 err)
{
	jc_t *c = (jc_t *)arg;
	if (!c) return ERR_OK;
	if (err != ERR_OK) {
		if (c->sock == pcb) {
			bte_disconnect(pcb);   /* frees the pcb */
			c->sock = NULL;
		}
		c->ev_failed = 1;
		return ERR_OK;
	}
	c->ev_connected = 1;
	return ERR_OK;
}

static s32 cb_connect_step2(void *arg, struct bte_pcb *pcb, u8 err)
{
	jc_t *c = (jc_t *)arg;
	if (!c) return ERR_OK;
	if (err == ERR_OK)
		err = bte_connectasync_step2(pcb, cb_connected);   /* data channel */
	if (err != ERR_OK) {
		if (c->sock == pcb) {
			bte_disconnect(pcb);
			c->sock = NULL;
		}
		c->ev_failed = 1;
	}
	return ERR_OK;
}

static s32 cb_inquiry(s32 result, void *userdata)
{
	struct bte_inquiry_res *res = (struct bte_inquiry_res *)userdata;
	int n = 0;
	if (result == ERR_OK && res && res->info) {
		for (int i = 0; i < res->count && n < MAX_CANDIDATES; i++) {
			if (bd_addr_cmp(&res->info[i].bdaddr, BD_ADDR_ANY)) continue;
			cand[n++] = res->info[i];
		}
	}
	cand_n = n;
	ev_inquiry_done = 1;
	return ERR_OK;
}

static s32 cb_name(s32 result, void *userdata)
{
	name_result = result;
	ev_name_done = 1;
	return ERR_OK;
}

/* ------------------------------------------------------------------------ */
/* Output                                                                   */
/* ------------------------------------------------------------------------ */

static s32 jc_send(jc_t *c, const u8 *buf, u16 len)
{
	u32 level;
	s32 ret = ERR_CONN;
	_CPU_ISR_Disable(level);
	if (c->sock) ret = bte_senddata(c->sock, (void *)buf, len);
	_CPU_ISR_Restore(level);
	return ret;
}

static void fill_rumble(jc_t *c, u8 *dst)
{
	const u8 *r = c->rumble_active ? RUMBLE_ON : RUMBLE_OFF;
	memcpy(dst, r, 4);       /* left actuator  */
	memcpy(dst + 4, r, 4);   /* right actuator */
}

static s32 jc_subcmd(jc_t *c, u8 sub, const u8 *args, int alen)
{
	u8 buf[OUT_REPORT_LEN];
	memset(buf, 0, sizeof(buf));
	buf[0] = 0x01;
	buf[1] = c->pkt_counter++ & 0x0F;
	fill_rumble(c, buf + 2);
	buf[10] = sub;
	if (alen > OUT_REPORT_LEN - 11) alen = OUT_REPORT_LEN - 11;
	if (args && alen > 0) memcpy(buf + 11, args, alen);
	return jc_send(c, buf, sizeof(buf));
}

static void jc_send_rumble(jc_t *c)
{
	u8 buf[OUT_REPORT_LEN];
	memset(buf, 0, sizeof(buf));
	buf[0] = 0x10;
	buf[1] = c->pkt_counter++ & 0x0F;
	fill_rumble(c, buf + 2);
	jc_send(c, buf, sizeof(buf));
}

static void jc_spi_read(jc_t *c, u32 addr, u8 size)
{
	u8 a[5] = { addr & 0xFF, (addr >> 8) & 0xFF, (addr >> 16) & 0xFF, (addr >> 24) & 0xFF, size };
	jc_subcmd(c, SUB_SPI_READ, a, 5);
}

/* ------------------------------------------------------------------------ */
/* Calibration parsing                                                      */
/* ------------------------------------------------------------------------ */

static void set_default_cal(jc_t *c)
{
	for (int i = 0; i < 3; i++) {
		c->acc_origin[i] = 0;
		c->acc_sens[i] = 16384;
		c->gyro_origin[i] = 0;
		c->gyro_sens[i] = 13371;
		c->bias[i] = 0.0f;
	}
	for (int i = 0; i < 2; i++) {
		c->lcal.center[i] = c->rcal.center[i] = 2048;
		c->lcal.above[i] = c->rcal.above[i] = 1400;
		c->lcal.below[i] = c->rcal.below[i] = 1400;
	}
}

static bool all_ff(const u8 *d, int n)
{
	for (int i = 0; i < n; i++) if (d[i] != 0xFF) return false;
	return true;
}

static void parse_imu_cal(jc_t *c, const u8 *d)
{
	if (all_ff(d, 24)) return;
	s16 ao[3], as[3], go[3], gs[3];
	for (int i = 0; i < 3; i++) {
		ao[i] = rd_s16(d + 0 + i * 2);
		as[i] = rd_s16(d + 6 + i * 2);
		go[i] = rd_s16(d + 12 + i * 2);
		gs[i] = rd_s16(d + 18 + i * 2);
	}
	for (int i = 0; i < 3; i++) {
		if (as[i] - ao[i] == 0 || gs[i] - go[i] == 0) return;  /* invalid */
	}
	memcpy(c->acc_origin, ao, sizeof(ao));
	memcpy(c->acc_sens, as, sizeof(as));
	memcpy(c->gyro_origin, go, sizeof(go));
	memcpy(c->gyro_sens, gs, sizeof(gs));
}

static void decode_stick_pair(const u8 *d, u16 *x, u16 *y)
{
	*x = ((d[1] << 8) & 0xF00) | d[0];
	*y = (d[2] << 4) | (d[1] >> 4);
}

static void parse_stick_cal(stick_cal_t *cal, const u8 *d, bool right)
{
	u16 v[3][2];
	if (all_ff(d, 9)) return;
	for (int i = 0; i < 3; i++) decode_stick_pair(d + i * 3, &v[i][0], &v[i][1]);
	stick_cal_t n;
	for (int a = 0; a < 2; a++) {
		if (!right) {   /* left: above, center, below */
			n.above[a] = v[0][a]; n.center[a] = v[1][a]; n.below[a] = v[2][a];
		} else {        /* right: center, below, above */
			n.center[a] = v[0][a]; n.below[a] = v[1][a]; n.above[a] = v[2][a];
		}
		if (n.center[a] == 0 || n.center[a] == 0xFFF || n.above[a] < 200 || n.below[a] < 200)
			return;     /* implausible, keep previous */
	}
	*cal = n;
}

static float stick_norm(u16 raw, const stick_cal_t *cal, int axis)
{
	float v = (float)raw - (float)cal->center[axis];
	v = (v > 0) ? v / (float)cal->above[axis] : v / (float)cal->below[axis];
	if (v > 1.0f) v = 1.0f;
	if (v < -1.0f) v = -1.0f;
	if (fabsf(v) < 0.08f) v = 0.0f;   /* dead zone */
	return v;
}

/* ------------------------------------------------------------------------ */
/* Input processing                                                         */
/* ------------------------------------------------------------------------ */

static void apply_axis_map(const s8 *map, const float in[3], jc_vec3_t *out)
{
	float o[3];
	for (int i = 0; i < 3; i++) {
		int src = map[i] < 0 ? -map[i] : map[i];
		float s = map[i] < 0 ? -1.0f : 1.0f;
		o[i] = (src >= 1 && src <= 3) ? s * in[src - 1] : 0.0f;
	}
	out->x = o[0]; out->y = o[1]; out->z = o[2];
}

static u16 mp_encode(float dps, bool *slow)
{
	float v;
	*slow = fabsf(dps) * MP_COUNTS_PER_DPS_SLOW < 8000.0f;
	v = 8192.0f + dps * (*slow ? MP_COUNTS_PER_DPS_SLOW : MP_COUNTS_PER_DPS_FAST);
	if (v < 0.0f) v = 0.0f;
	if (v > 16383.0f) v = 16383.0f;
	return (u16)v;
}

static float wrap180(float a)
{
	while (a > 180.0f) a -= 360.0f;
	while (a < -180.0f) a += 360.0f;
	return a;
}

static void accel_angles(const jc_vec3_t *a, float *pitch, float *roll)
{
	*pitch = atan2f(a->y, sqrtf(a->x * a->x + a->z * a->z)) * (180.0f / (float)M_PI);
	*roll  = atan2f(-a->x, a->z) * (180.0f / (float)M_PI);
}

/* raw sensor frame -> calibrated -> axis mapped (Wii Remote frame) */
static float last_raw_acc[JC_MAX_CONTROLLERS][3];

static void process_imu_sample(jc_t *c, const u8 *s)
{
	float acc[3], gyr[3];
	jc_state_t *st = &c->pub;
	int t = (st->type <= JC_TYPE_PRO) ? st->type : 0;
	int idx = (int)(c - pads);

	for (int i = 0; i < 3; i++) {
		s16 ar = rd_s16(s + i * 2);
		s16 gr = rd_s16(s + 6 + i * 2);
		acc[i] = (float)ar * 4.0f / (float)(c->acc_sens[i] - c->acc_origin[i]);
		gyr[i] = (float)(gr - c->gyro_origin[i]) * 936.0f / (float)(c->gyro_sens[i] - c->gyro_origin[i]);
		last_raw_acc[idx][i] = acc[i];
	}

	apply_axis_map(axis_map[t], acc, &st->accel);
	jc_vec3_t g;
	apply_axis_map(axis_map[t], gyr, &g);

	if (st->status == JC_STATUS_CALIBRATING) {
		float mag = fabsf(g.x - (c->calib_n ? c->calib_sum[0] / c->calib_n : g.x)) +
		            fabsf(g.y - (c->calib_n ? c->calib_sum[1] / c->calib_n : g.y)) +
		            fabsf(g.z - (c->calib_n ? c->calib_sum[2] / c->calib_n : g.z));
		if (mag > CALIB_MAX_MOTION_DPS) {
			/* moved - start over */
			c->calib_n = 0;
			c->calib_sum[0] = c->calib_sum[1] = c->calib_sum[2] = 0.0f;
		}
		c->calib_sum[0] += g.x; c->calib_sum[1] += g.y; c->calib_sum[2] += g.z;
		if (++c->calib_n >= CALIB_SAMPLES) {
			c->bias[0] = c->calib_sum[0] / c->calib_n;
			c->bias[1] = c->calib_sum[1] / c->calib_n;
			c->bias[2] = c->calib_sum[2] / c->calib_n;
			st->status = JC_STATUS_READY;
			c->have_orientation = false;
			jc_log("Pad %d bereit (Bias %.1f %.1f %.1f)", idx + 1, c->bias[0], c->bias[1], c->bias[2]);
		}
	}

	st->gyro.x = g.x - c->bias[0];
	st->gyro.y = g.y - c->bias[1];
	st->gyro.z = g.z - c->bias[2];

	st->mp.rx = mp_encode(st->gyro.x, &st->mp.slow_pitch);
	st->mp.ry = mp_encode(st->gyro.y, &st->mp.slow_roll);
	st->mp.rz = mp_encode(st->gyro.z, &st->mp.slow_yaw);

	/* complementary filter */
	float ap, ar;
	accel_angles(&st->accel, &ap, &ar);
	if (!c->have_orientation) {
		st->pitch = ap; st->roll = ar; st->yaw = 0.0f;
		c->have_orientation = true;
		return;
	}
	float amag = sqrtf(st->accel.x * st->accel.x + st->accel.y * st->accel.y + st->accel.z * st->accel.z);
	float k = (amag > 0.7f && amag < 1.3f) ? 0.02f : 0.0f;
	st->pitch = (1.0f - k) * (st->pitch + st->gyro.x * IMU_SAMPLE_DT) + k * ap;
	/* roll from the accelerometer is unreliable near +-90 deg pitch */
	float kr = (fabsf(ap) < 70.0f) ? k : 0.0f;
	float roll_pred = wrap180(st->roll + st->gyro.y * IMU_SAMPLE_DT);
	float droll = wrap180(ar - roll_pred);
	st->roll = wrap180(roll_pred + kr * droll);
	st->yaw = wrap180(st->yaw + st->gyro.z * IMU_SAMPLE_DT);
}

static void parse_standard(jc_t *c, const u8 *d)
{
	jc_state_t *st = &c->pub;
	u8 bat = d[2];
	st->battery = bat >> 5;
	st->charging = (bat >> 4) & 1;
	st->buttons = d[3] | (d[4] << 8) | (d[5] << 16);

	u16 lx, ly, rx, ry;
	decode_stick_pair(d + 6, &lx, &ly);
	decode_stick_pair(d + 9, &rx, &ry);
	st->lstick_x = stick_norm(lx, &c->lcal, 0);
	st->lstick_y = stick_norm(ly, &c->lcal, 1);
	st->rstick_x = stick_norm(rx, &c->rcal, 0);
	st->rstick_y = stick_norm(ry, &c->rcal, 1);
	if (st->type == JC_TYPE_RIGHT) st->lstick_x = st->lstick_y = 0.0f;
	if (st->type == JC_TYPE_LEFT)  st->rstick_x = st->rstick_y = 0.0f;
}

static void advance_step(jc_t *c)
{
	c->step++;
	c->tries = 0;
	c->t_cmd = 0;   /* send next command immediately */
}

static void handle_reply(jc_t *c, const u8 *d, int len)
{
	u8 ack = d[13];
	u8 sub = d[14];
	const u8 *r = d + 15;

	if (c->pub.status != JC_STATUS_INITIALIZING) return;
	if (!(ack & 0x80)) return;

	switch (c->step) {
	case STEP_DEVICE_INFO:
		if (sub != SUB_DEVICE_INFO) return;
		if (r[2] >= JC_TYPE_LEFT && r[2] <= JC_TYPE_PRO) c->pub.type = (jc_type_t)r[2];
		jc_log("Pad %d: FW %d.%02d, Typ %d", (int)(c - pads) + 1, r[0], r[1], r[2]);
		break;
	case STEP_SPI_FACTORY_IMU:
	case STEP_SPI_FACTORY_STICK:
	case STEP_SPI_USER_STICK:
	case STEP_SPI_USER_IMU: {
		if (sub != SUB_SPI_READ || len < 20) return;
		u32 addr = r[0] | (r[1] << 8) | (r[2] << 16) | ((u32)r[3] << 24);
		u8 size = r[4];
		const u8 *data = r + 5;
		if (20 + size > len) return;
		if (c->step == STEP_SPI_FACTORY_IMU && addr == SPI_FACTORY_IMU && size >= 24) {
			parse_imu_cal(c, data);
		} else if (c->step == STEP_SPI_FACTORY_STICK && addr == SPI_FACTORY_STICK && size >= 18) {
			parse_stick_cal(&c->lcal, data, false);
			parse_stick_cal(&c->rcal, data + 9, true);
		} else if (c->step == STEP_SPI_USER_STICK && addr == SPI_USER_STICK && size >= 22) {
			if (data[0] == 0xB2 && data[1] == 0xA1) parse_stick_cal(&c->lcal, data + 2, false);
			if (data[11] == 0xB2 && data[12] == 0xA1) parse_stick_cal(&c->rcal, data + 13, true);
		} else if (c->step == STEP_SPI_USER_IMU && addr == SPI_USER_IMU && size >= 26) {
			if (data[0] == 0xB2 && data[1] == 0xA1) {
				parse_imu_cal(c, data + 2);
				jc_log("Pad %d: Benutzer-IMU-Kalibrierung", (int)(c - pads) + 1);
			}
		} else {
			return;   /* reply to something else */
		}
		break;
	}
	case STEP_IMU_ENABLE:  if (sub != SUB_IMU_ENABLE)  return; break;
	case STEP_VIBRATION:   if (sub != SUB_VIBRATION)   return; break;
	case STEP_REPORT_MODE: if (sub != SUB_REPORT_MODE) return; break;
	case STEP_PLAYER_LEDS: if (sub != SUB_PLAYER_LEDS) return; break;
	default: return;
	}
	advance_step(c);
}

static void process_packet(jc_t *c, const u8 *d, int len)
{
	if (len < 1) return;
	switch (d[0]) {
	case 0x21:   /* subcommand reply (+ standard input) */
		if (len >= 13) parse_standard(c, d);
		if (len >= 15) handle_reply(c, d, len);
		break;
	case 0x30:   /* standard full mode: input + 3 IMU samples */
		if (len >= 13) parse_standard(c, d);
		if (len >= 49 && (c->pub.status == JC_STATUS_CALIBRATING || c->pub.status == JC_STATUS_READY)) {
			for (int i = 0; i < 3; i++) process_imu_sample(c, d + 13 + i * 12);
			c->pub.reports++;
			c->rate_count++;
		}
		break;
	default:     /* 0x3F simple HID mode etc. - ignored */
		break;
	}
}

/* ------------------------------------------------------------------------ */
/* Init sequence                                                            */
/* ------------------------------------------------------------------------ */

static void send_step(jc_t *c)
{
	u8 arg;
	switch (c->step) {
	case STEP_DEVICE_INFO:       jc_subcmd(c, SUB_DEVICE_INFO, NULL, 0); break;
	case STEP_SPI_FACTORY_IMU:   jc_spi_read(c, SPI_FACTORY_IMU, 24); break;
	case STEP_SPI_FACTORY_STICK: jc_spi_read(c, SPI_FACTORY_STICK, 18); break;
	case STEP_SPI_USER_STICK:    jc_spi_read(c, SPI_USER_STICK, 22); break;
	case STEP_SPI_USER_IMU:      jc_spi_read(c, SPI_USER_IMU, 26); break;
	case STEP_IMU_ENABLE:        arg = 0x01; jc_subcmd(c, SUB_IMU_ENABLE, &arg, 1); break;
	case STEP_VIBRATION:         arg = 0x01; jc_subcmd(c, SUB_VIBRATION, &arg, 1); break;
	case STEP_REPORT_MODE:       arg = 0x30; jc_subcmd(c, SUB_REPORT_MODE, &arg, 1); break;
	case STEP_PLAYER_LEDS:       arg = 1 << ((c - pads) & 3); jc_subcmd(c, SUB_PLAYER_LEDS, &arg, 1); break;
	default: break;
	}
}

static void set_status(jc_t *c, jc_status_t s)
{
	c->pub.status = s;
	c->t_state = gettime();
}

static void start_calibration(jc_t *c)
{
	c->calib_n = 0;
	c->calib_sum[0] = c->calib_sum[1] = c->calib_sum[2] = 0.0f;
	set_status(c, JC_STATUS_CALIBRATING);
}

static void run_init(jc_t *c)
{
	if (ms_since(c->t_state) < INIT_DELAY_MS) return;

	if (c->step >= STEP_DONE) {
		jc_log("Pad %d initialisiert - bitte ruhig hinlegen", (int)(c - pads) + 1);
		start_calibration(c);
		JC_Rumble((int)(c - pads), 200);
		return;
	}

	if (c->t_cmd == 0 || ms_since(c->t_cmd) >= SUBCMD_RETRY_MS) {
		if (c->tries >= SUBCMD_MAX_TRIES) {
			/* no answer - carry on with defaults, the controller may still work */
			jc_log("Pad %d: Schritt %d ohne Antwort", (int)(c - pads) + 1, c->step);
			advance_step(c);
			return;
		}
		send_step(c);
		c->tries++;
		c->t_cmd = gettime();
	}
}

/* ------------------------------------------------------------------------ */
/* Slot management                                                          */
/* ------------------------------------------------------------------------ */

static void reset_slot(jc_t *c)
{
	memset(c, 0, sizeof(*c));
	set_default_cal(c);
}

static bool addr_in_use(const struct bd_addr *a)
{
	for (int i = 0; i < JC_MAX_CONTROLLERS; i++) {
		if (pads[i].pub.status != JC_STATUS_EMPTY && bd_addr_cmp(&pads[i].addr, a)) return true;
	}
	return false;
}

static int start_connect(const struct bd_addr *a, jc_type_t type_hint)
{
	int slot = -1;
	for (int i = 0; i < JC_MAX_CONTROLLERS; i++) {
		if (pads[i].pub.status == JC_STATUS_EMPTY) { slot = i; break; }
	}
	if (slot < 0) return -1;

	jc_t *c = &pads[slot];
	reset_slot(c);
	bd_addr_set(&c->addr, a);
	addr_to_bytes(c->pub.bdaddr, a);
	c->pub.type = type_hint;

	struct bte_pcb *pcb = bte_new();
	if (!pcb) { jc_log("bte_new fehlgeschlagen"); return -1; }

	bte_arg(pcb, c);
	bte_received(pcb, cb_receive);
	bte_disconnected(pcb, cb_disconnected);

	u32 level;
	_CPU_ISR_Disable(level);
	c->sock = pcb;
	set_status(c, JC_STATUS_CONNECTING);
	s32 err = bte_connectasync(pcb, &c->addr, cb_connect_step2);
	if (err != ERR_OK) {
		c->sock = NULL;
		bte_free(pcb);
		c->pub.status = JC_STATUS_EMPTY;
		_CPU_ISR_Restore(level);
		jc_log("Verbindung fehlgeschlagen (%d)", (int)err);
		return -1;
	}
	_CPU_ISR_Restore(level);
	return slot;
}

static void drop_slot(jc_t *c, const char *why)
{
	u32 level;
	_CPU_ISR_Disable(level);
	if (c->sock) {
		bte_disconnect(c->sock);   /* frees the pcb */
		c->sock = NULL;
	}
	_CPU_ISR_Restore(level);
	if (why) jc_log("Pad %d: %s", (int)(c - pads) + 1, why);
	reset_slot(c);
}

/* ------------------------------------------------------------------------ */
/* Scanning                                                                 */
/* ------------------------------------------------------------------------ */

static void start_inquiry(void)
{
	ev_inquiry_done = 0;
	cand_n = 0;
	scan_state = JC_SCAN_INQUIRY;
	t_scan = gettime();
	/* Note: if no device at all answers, libogc keeps re-issuing the inquiry
	 * by itself until something is found. */
	BTE_Inquiry(MAX_CANDIDATES, TRUE, cb_inquiry);
}

static void next_candidate(void)
{
	while (cand_idx < cand_n) {
		struct inquiry_info_ex *ci = &cand[cand_idx];
		if (addr_in_use(&ci->bdaddr)) { cand_idx++; continue; }
		memset(&name_info, 0, sizeof(name_info));
		bd_addr_set(&name_info.bdaddr, &ci->bdaddr);
		ev_name_done = 0;
		scan_state = JC_SCAN_NAMES;
		t_scan = gettime();
		BTE_ReadRemoteName(&name_info, cb_name);
		return;
	}
	/* all candidates handled: search again after a short pause */
	scan_state = JC_SCAN_OFF;
	t_scan = gettime();
}

static jc_type_t type_from_name(const char *name)
{
	if (strstr(name, "Joy-Con (L)")) return JC_TYPE_LEFT;
	if (strstr(name, "Joy-Con (R)")) return JC_TYPE_RIGHT;
	if (strstr(name, "Pro Controller")) return JC_TYPE_PRO;
	if (strstr(name, "Joy-Con")) return JC_TYPE_UNKNOWN;
	return (jc_type_t)-1;
}

static void run_scan(void)
{
	switch (scan_state) {
	case JC_SCAN_OFF:
		if (scan_wanted && JC_NumConnected() < JC_MAX_CONTROLLERS && ms_since(t_scan) > 500)
			start_inquiry();
		break;

	case JC_SCAN_INQUIRY:
		if (ev_inquiry_done) {
			ev_inquiry_done = 0;
			cand_idx = 0;
			if (scan_wanted) {
				next_candidate();
			} else {
				scan_state = JC_SCAN_OFF;
				t_scan = gettime();
			}
		}
		break;

	case JC_SCAN_NAMES:
		if (ev_name_done) {
			ev_name_done = 0;
			struct inquiry_info_ex *ci = &cand[cand_idx];
			cand_idx++;
			if (name_result == ERR_OK) {
				char name[64];
				memcpy(name, name_info.name, sizeof(name) - 1);
				name[sizeof(name) - 1] = 0;
				jc_type_t t = type_from_name(name);
				if ((int)t >= 0 && scan_wanted) {
					jc_log("Gefunden: %s", name);
					connecting_slot = start_connect(&ci->bdaddr, t);
					if (connecting_slot >= 0) {
						scan_state = JC_SCAN_CONNECTING;
						t_scan = gettime();
						break;
					}
				}
			}
			next_candidate();
		} else if (ms_since(t_scan) > NAME_TIMEOUT_MS) {
			cand_idx++;
			next_candidate();
		}
		break;

	case JC_SCAN_CONNECTING:
		if (connecting_slot < 0 || pads[connecting_slot].pub.status != JC_STATUS_CONNECTING) {
			connecting_slot = -1;
			next_candidate();
		}
		break;
	}
}

/* ------------------------------------------------------------------------ */
/* Public API                                                               */
/* ------------------------------------------------------------------------ */

s32 JC_Init(void)
{
	for (int i = 0; i < JC_MAX_CONTROLLERS; i++) reset_slot(&pads[i]);
	memset(log_buf, 0, sizeof(log_buf));
	scan_state = JC_SCAN_OFF;
	scan_wanted = false;
	jc_inited = true;
	jc_log("Joy-Con Treiber bereit");
	return 0;
}

void JC_Shutdown(void)
{
	if (!jc_inited) return;
	scan_wanted = false;
	for (int i = 0; i < JC_MAX_CONTROLLERS; i++) {
		if (pads[i].pub.status != JC_STATUS_EMPTY) drop_slot(&pads[i], NULL);
	}
	jc_inited = false;
}

void JC_StartScan(void)
{
	scan_wanted = true;
	if (scan_state == JC_SCAN_OFF) t_scan = 0;
	jc_log("Suche gestartet - Sync-Taste am Joy-Con halten");
}

void JC_StopScan(void)
{
	scan_wanted = false;
	jc_log("Suche beendet");
}

jc_scan_t JC_GetScanState(void)
{
	return scan_wanted ? (scan_state == JC_SCAN_OFF ? JC_SCAN_INQUIRY : scan_state) : JC_SCAN_OFF;
}

void JC_Update(void)
{
	if (!jc_inited) return;

	for (int i = 0; i < JC_MAX_CONTROLLERS; i++) {
		jc_t *c = &pads[i];
		if (c->pub.status == JC_STATUS_EMPTY) continue;

		/* connection events */
		if (c->ev_failed) {
			c->ev_failed = 0;
			drop_slot(c, "Verbindung abgelehnt");
			continue;
		}
		if (c->ev_disconnected) {
			c->ev_disconnected = 0;
			drop_slot(c, "getrennt");
			continue;
		}
		if (c->pub.status == JC_STATUS_CONNECTING) {
			if (c->ev_connected) {
				c->ev_connected = 0;
				jc_log("Pad %d verbunden", i + 1);
				c->step = STEP_DEVICE_INFO;
				c->tries = 0;
				c->t_cmd = 0;
				set_status(c, JC_STATUS_INITIALIZING);
			} else if (ms_since(c->t_state) > CONNECT_TIMEOUT_MS) {
				drop_slot(c, "Zeitueberschreitung");
				continue;
			}
		}

		/* received packets */
		u32 w = c->ring_w;
		if (w - c->ring_r > RX_RING_SIZE) c->ring_r = w - RX_RING_SIZE;   /* overrun */
		while (c->ring_r != w) {
			rx_pkt_t pkt = c->ring[c->ring_r % RX_RING_SIZE];
			c->ring_r++;
			process_packet(c, pkt.data, pkt.len);
		}

		if (c->pub.status == JC_STATUS_INITIALIZING) run_init(c);

		/* button edges */
		c->pub.down = c->pub.buttons & ~c->prev_buttons;
		c->pub.up = ~c->pub.buttons & c->prev_buttons;
		c->prev_buttons = c->pub.buttons;

		/* rumble timeout */
		if (c->rumble_active && gettime() >= c->rumble_until) {
			c->rumble_active = false;
			jc_send_rumble(c);
		}

		/* report rate */
		if (c->t_rate == 0) c->t_rate = gettime();
		if (ms_since(c->t_rate) >= 1000) {
			c->pub.report_rate = c->rate_count;
			c->rate_count = 0;
			c->t_rate = gettime();
		}
	}

	run_scan();
}

const jc_state_t *JC_GetState(int idx)
{
	if (idx < 0 || idx >= JC_MAX_CONTROLLERS) return NULL;
	return &pads[idx].pub;
}

int JC_NumConnected(void)
{
	int n = 0;
	for (int i = 0; i < JC_MAX_CONTROLLERS; i++)
		if (pads[i].pub.status >= JC_STATUS_INITIALIZING) n++;
	return n;
}

void JC_Recenter(int idx)
{
	if (idx < 0 || idx >= JC_MAX_CONTROLLERS) return;
	pads[idx].have_orientation = false;
}

void JC_CalibrateGyro(int idx)
{
	if (idx < 0 || idx >= JC_MAX_CONTROLLERS) return;
	jc_t *c = &pads[idx];
	if (c->pub.status != JC_STATUS_READY) return;
	start_calibration(c);
	jc_log("Pad %d: Gyro-Kalibrierung - ruhig halten", idx + 1);
}

void JC_Rumble(int idx, int ms)
{
	if (idx < 0 || idx >= JC_MAX_CONTROLLERS) return;
	jc_t *c = &pads[idx];
	if (c->pub.status < JC_STATUS_INITIALIZING) return;
	c->rumble_active = ms > 0;
	c->rumble_until = gettime() + millisecs_to_ticks(ms > 0 ? ms : 0);
	jc_send_rumble(c);
}

void JC_Disconnect(int idx)
{
	if (idx < 0 || idx >= JC_MAX_CONTROLLERS) return;
	if (pads[idx].pub.status != JC_STATUS_EMPTY) drop_slot(&pads[idx], "getrennt");
}

/* --- axis mapping helpers (used by the setup wizard in main.c) --- */

void JC_SetAxisMap(jc_type_t type, const s8 map[3])
{
	if ((int)type < 0 || type > JC_TYPE_PRO) return;
	memcpy(axis_map[type], map, 3);
	if (type == JC_TYPE_LEFT) memcpy(axis_map[JC_TYPE_UNKNOWN], map, 3);
	for (int i = 0; i < JC_MAX_CONTROLLERS; i++) {
		if (pads[i].pub.type == type && pads[i].pub.status == JC_STATUS_READY) start_calibration(&pads[i]);
	}
}

void JC_GetAxisMap(jc_type_t type, s8 map[3])
{
	if ((int)type < 0 || type > JC_TYPE_PRO) type = JC_TYPE_UNKNOWN;
	memcpy(map, axis_map[type], 3);
}

void JC_GetRawAccel(int idx, float out[3])
{
	if (idx < 0 || idx >= JC_MAX_CONTROLLERS) return;
	memcpy(out, last_raw_acc[idx], sizeof(float) * 3);
}
