#ifndef BT_HOST_H
#define BT_HOST_H

/*
 * bt_host: lets the module talk to the real Bluetooth controller on its own
 * (HCI commands + ACL data), interleaved with the game's traffic, and hides
 * every event / ACL packet that belongs to the module's own connections from
 * the game's Bluetooth stack.
 */

#include <stdbool.h>

#include "ipc.h"
#include "types.h"

/* Called from main.c */
void bt_host_init(void);
void bt_host_set_fd(int fd);
/* Returns a message to hand down to OH1 or NULL */
ipcmessage *bt_host_next_outgoing(void);
/* Returns true if the message was one of ours (it must not be ACKed then) */
bool bt_host_handle_reply(ipcmessage *msg, int retval);
/* Returns true if the event was consumed (must not reach the game) */
bool bt_host_filter_hci_event(u8 *data, u32 length);
/* Returns true if the ACL packet was consumed (must not reach the game) */
bool bt_host_filter_acl_in(u8 *data, u32 length);
/* Called for every HCI command the game sends */
void bt_host_snoop_hci_cmd_from_host(const u8 *data, u32 length);

/* Used by the Joy-Con driver */
bool bt_host_ready(void);
const u8 *bt_host_local_bdaddr(void); /* little endian, as reported by the controller */
bool bt_host_send_cmd(u16 opcode, const void *params, u8 len);
bool bt_host_send_acl(u16 con_handle, const void *data, u16 len);

#endif
