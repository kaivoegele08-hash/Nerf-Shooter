/*
 * joycon.h - Nintendo Switch Joy-Con / Pro Controller driver for Wii homebrew
 *
 * Talks to the controllers directly over the Wii's Bluetooth module using the
 * libogc BTE (lwBT) stack - the same stack WPAD uses for Wii Remotes. Joy-Cons
 * and Wii Remotes (incl. MotionPlus) can therefore be used at the same time.
 *
 * Usage:
 *   WPAD_Init();          // brings up the Bluetooth stack
 *   JC_Init();
 *   JC_StartScan();       // Joy-Con: hold the small sync button on the rail
 *   while (running) {
 *       JC_Update();      // call once per frame (main thread, NOT from an IRQ)
 *       const jc_state_t *jc = JC_GetState(0);
 *       ...
 *   }
 *   JC_Shutdown();
 */
#ifndef __JOYCON_H__
#define __JOYCON_H__

#include <gctypes.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define JC_MAX_CONTROLLERS 4

typedef enum {
	JC_TYPE_UNKNOWN = 0,
	JC_TYPE_LEFT    = 1,  /* Joy-Con (L)    */
	JC_TYPE_RIGHT   = 2,  /* Joy-Con (R)    */
	JC_TYPE_PRO     = 3   /* Pro Controller */
} jc_type_t;

typedef enum {
	JC_STATUS_EMPTY = 0,     /* slot unused                               */
	JC_STATUS_CONNECTING,    /* L2CAP channels being opened               */
	JC_STATUS_INITIALIZING,  /* reading calibration / enabling the IMU    */
	JC_STATUS_CALIBRATING,   /* measuring gyro bias - keep it still!      */
	JC_STATUS_READY          /* streaming input + motion data             */
} jc_status_t;

typedef enum {
	JC_SCAN_OFF = 0,
	JC_SCAN_INQUIRY,         /* looking for discoverable devices          */
	JC_SCAN_NAMES,           /* reading device names of the results       */
	JC_SCAN_CONNECTING       /* waiting for a controller to connect       */
} jc_scan_t;

/* Buttons (bit mask in jc_state_t.buttons). Identical layout to the
 * Joy-Con input report: byte3 | byte4 << 8 | byte5 << 16. */
#define JC_BTN_Y        0x000001
#define JC_BTN_X        0x000002
#define JC_BTN_B        0x000004
#define JC_BTN_A        0x000008
#define JC_BTN_R_SR     0x000010
#define JC_BTN_R_SL     0x000020
#define JC_BTN_R        0x000040
#define JC_BTN_ZR       0x000080
#define JC_BTN_MINUS    0x000100
#define JC_BTN_PLUS     0x000200
#define JC_BTN_RSTICK   0x000400
#define JC_BTN_LSTICK   0x000800
#define JC_BTN_HOME     0x001000
#define JC_BTN_CAPTURE  0x002000
#define JC_BTN_DOWN     0x010000
#define JC_BTN_UP       0x020000
#define JC_BTN_RIGHT    0x040000
#define JC_BTN_LEFT     0x080000
#define JC_BTN_L_SR     0x100000
#define JC_BTN_L_SL     0x200000
#define JC_BTN_L        0x400000
#define JC_BTN_ZL       0x800000

/* A 3D vector in the *Wii Remote* coordinate system:
 *   x = right, y = forward (pointing direction), z = up (out of the buttons)
 * when a single Joy-Con is held upright like a Wii Remote (top end pointing
 * at the screen, buttons facing up). */
typedef struct {
	float x, y, z;
} jc_vec3_t;

/* Wii MotionPlus compatible gyro data, same convention as libogc's
 * struct motion_plus_t (rx = pitch, ry = roll, rz = yaw): 14 bit values,
 * 8192 = no rotation, ~20 counts per deg/s ("slow mode"). Values are
 * clamped to 0..16383. */
typedef struct {
	u16 rx, ry, rz;
	bool slow_pitch, slow_roll, slow_yaw;   /* true = slow (precise) mode */
} jc_motionplus_t;

typedef struct {
	jc_status_t status;
	jc_type_t   type;
	u8          bdaddr[6];
	int         battery;      /* 0 (empty) .. 4 (full)                     */
	bool        charging;

	u32         buttons;      /* currently held (JC_BTN_*)                 */
	u32         down;         /* pressed since last JC_Update()            */
	u32         up;           /* released since last JC_Update()           */

	/* Analog sticks normalized to -1.0 .. 1.0 (Joy-Con L / Pro use 'lstick',
	 * Joy-Con R / Pro use 'rstick'). */
	float lstick_x, lstick_y;
	float rstick_x, rstick_y;

	jc_vec3_t   accel;        /* in G, latest sample                       */
	jc_vec3_t   gyro;         /* in deg/s, bias corrected, latest sample   */
	jc_motionplus_t mp;       /* gyro encoded like a Wii MotionPlus        */

	/* Orientation estimate (complementary filter), in degrees.
	 * pitch: + = tip up, roll: + = rotate clockwise, yaw: + = turn left.
	 * Yaw drifts slowly; use JC_Recenter(). */
	float pitch, roll, yaw;

	u32 reports;              /* number of IMU input reports received      */
	u32 report_rate;          /* input reports per second                  */
} jc_state_t;

/* Must be called after WPAD_Init() (which starts the Bluetooth stack). */
s32  JC_Init(void);
void JC_Shutdown(void);

/* Process received data and drive the connection state machine.
 * Call once per video frame from the main thread. */
void JC_Update(void);

/* Search for Joy-Cons in pairing mode (sync button held / LEDs running). */
void JC_StartScan(void);
void JC_StopScan(void);
jc_scan_t JC_GetScanState(void);

const jc_state_t *JC_GetState(int idx);
int  JC_NumConnected(void);

/* Reset yaw (and pitch/roll to the accelerometer estimate). */
void JC_Recenter(int idx);
/* Re-measure the gyro bias. Keep the controller still for ~1 second. */
void JC_CalibrateGyro(int idx);
/* Short rumble pulse (0 = off, otherwise milliseconds). */
void JC_Rumble(int idx, int ms);
void JC_Disconnect(int idx);

/* Axis mapping from the IMU's sensor frame to the Wii Remote frame.
 * map[i] for output axis i (x=right, y=forward, z=up) = +-(1..3), i.e. the
 * source sensor axis (1=x, 2=y, 3=z) and its sign. */
void JC_SetAxisMap(jc_type_t type, const s8 map[3]);
void JC_GetAxisMap(jc_type_t type, s8 map[3]);
/* Calibrated accelerometer in the *sensor* frame (G), for the axis wizard. */
void JC_GetRawAccel(int idx, float out[3]);

/* Last few log lines of the driver (for on-screen diagnostics). */
int  JC_GetLog(const char **lines, int max);

#ifdef __cplusplus
}
#endif

#endif /* __JOYCON_H__ */
