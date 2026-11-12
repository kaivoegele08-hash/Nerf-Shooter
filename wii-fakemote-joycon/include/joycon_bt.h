#ifndef JOYCON_BT_H
#define JOYCON_BT_H

#include <stdbool.h>

#include "types.h"

/* Path of the config file written by the "Joy-Con Bridge" homebrew app:
 * up to JOYCON_MAX_ADDRS * 6 bytes, Bluetooth addresses in display order
 * (e.g. 70 2C 09 D8 00 AF). */
#define JOYCON_CONF_PATH "/shared2/fakemote_joycon.bin"
#define JOYCON_MAX_ADDRS 2

/* Called from main() at module start (reads the config file) */
void joycon_bt_load_config(void);

/* Called from the periodic 5 ms timer */
void joycon_bt_tick(void);

/* Called by bt_host */
bool joycon_bt_owns_handle(u16 con_handle);
bool joycon_bt_handle_event(u8 event, const u8 *params, u8 len);
void joycon_bt_handle_acl(u16 con_handle, const u8 *data, u16 len);
void joycon_bt_cmd_done(u16 opcode, u8 status, const u8 *params, u8 len);
void joycon_bt_cmd_failed(u16 opcode);
void joycon_bt_reset_all(void);
void bt_host_tick(void);

#endif
