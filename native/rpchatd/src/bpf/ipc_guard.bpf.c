// The IPC guard: the one `connect()` check AppArmor cannot make on a mainstream kernel.
//
// See docs/spec/ipc-guard-bpf.md. The short version: AppArmor's fine-grained `unix` mediation
// class is absent from every current kernel, so a `deny unix (connect) …` rule loads and
// mediates nothing, and the file rule on the socket node only covers `open()`. A BPF LSM
// program has the hook AppArmor lacks, so the wallpaper lock is finished here.
//
// The decision is entirely table-driven; nothing about rpchat is compiled in:
//
//   `rpchat_targets`  the socket nodes to mediate, keyed by (device, inode). The daemon stats
//                     the shell's sockets and fills this in, refreshing whenever the shell
//                     rebinds (a new inode) — see `ipcguard.rs`.
//   `rpchat_allowed`  cgroups whose tasks may connect anyway: the app's, so everything the
//                     character launches keeps working, and each socket server's, so the bar
//                     may still drive the wallpaper daemon.
//   `rpchat_mode`     0 off, 1 audit (report only), 2 enforce (report and deny).
//   `rpchat_events`   one record per attempt, for the daemon's `guard-attempt` events.
//
// Anything unexpected — an unreadable path, a missing map, an abstract socket — returns 0 and
// lets the connection through. A guard that bricks a desktop when it is confused is worse than
// the gap it closes.
#include "vmlinux.h"

#include <bpf/bpf_core_read.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

#define EACCES 13

// Keep in step with `ipcguard.rs`: MAX_TARGETS/MAX_ALLOWED_CGROUPS/Mode are asserted there.
#define MAX_TARGETS 1024
#define MAX_ALLOWED_CGROUPS 8

#define MODE_OFF 0
#define MODE_AUDIT 1
#define MODE_ENFORCE 2

// The kernel's `dev_t` packs the minor into 20 bits; glibc's packs it differently, so the two
// sides agree on major/minor rather than on the encoded number.
#define DEV_MAJOR(dev) ((dev) >> 20)
#define DEV_MINOR(dev) ((dev) & 0xfffff)

struct rpchat_target_key {
	__u32 dev_major;
	__u32 dev_minor;
	__u64 ino;
};

// Mirrored by `ipcguard::Event`; both sides are `repr(C)` with explicit widths and no padding.
struct rpchat_event {
	__u32 dev_major;
	__u32 dev_minor;
	__u64 ino;
	__u32 pid;
	__u32 blocked;
	char comm[16];
};

struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, MAX_TARGETS);
	__type(key, struct rpchat_target_key);
	__type(value, __u8);
} rpchat_targets SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_CGROUP_ARRAY);
	__uint(max_entries, MAX_ALLOWED_CGROUPS);
	__type(key, __u32);
	__type(value, __u32);
} rpchat_allowed SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, __u32);
} rpchat_mode SEC(".maps");

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 16);
} rpchat_events SEC(".maps");

// Is the calling task inside one of the allowed cgroups? The loop is unrolled so every index
// is a constant, which is what the helper wants; an empty slot returns negative, not 0.
static __always_inline int caller_is_allowed(void)
{
	int i;

#pragma unroll
	for (i = 0; i < MAX_ALLOWED_CGROUPS; i++) {
		if (bpf_current_task_under_cgroup(&rpchat_allowed, i) > 0)
			return 1;
	}
	return 0;
}

// `other` is the *server* socket being connected to — the one the map is keyed on. `ret` is
// what the LSM hooks ahead of this one decided; a denial there stands.
SEC("lsm/unix_stream_connect")
int BPF_PROG(rpchat_unix_stream_connect, struct sock *sock, struct sock *other,
	     struct sock *newsk, int ret)
{
	struct rpchat_target_key key = {};
	struct unix_sock *server;
	struct rpchat_event *event;
	struct dentry *dentry;
	struct inode *inode;
	__u32 zero = 0;
	__u32 *mode;
	__u32 dev;
	__u8 *row;
	int blocked;

	if (ret != 0)
		return ret;

	mode = bpf_map_lookup_elem(&rpchat_mode, &zero);
	if (!mode || *mode == MODE_OFF)
		return 0;

	// An abstract or unnamed socket has no dentry, and nothing this guard protects is one.
	server = (struct unix_sock *)other;
	dentry = BPF_CORE_READ(server, path.dentry);
	if (!dentry)
		return 0;
	inode = BPF_CORE_READ(dentry, d_inode);
	if (!inode)
		return 0;

	key.ino = BPF_CORE_READ(inode, i_ino);
	dev = BPF_CORE_READ(inode, i_sb, s_dev);
	key.dev_major = DEV_MAJOR(dev);
	key.dev_minor = DEV_MINOR(dev);

	row = bpf_map_lookup_elem(&rpchat_targets, &key);
	if (!row)
		return 0;
	if (caller_is_allowed())
		return 0;

	blocked = *mode == MODE_ENFORCE;
	// Reporting is best-effort: a full ring buffer must not turn into an allowed connection.
	event = bpf_ringbuf_reserve(&rpchat_events, sizeof(*event), 0);
	if (event) {
		event->dev_major = key.dev_major;
		event->dev_minor = key.dev_minor;
		event->ino = key.ino;
		event->pid = bpf_get_current_pid_tgid() >> 32;
		event->blocked = blocked;
		bpf_get_current_comm(&event->comm, sizeof(event->comm));
		bpf_ringbuf_submit(event, 0);
	}

	// -EACCES, so a blocked client sees exactly what the AppArmor path would have given it.
	return blocked ? -EACCES : 0;
}

// The kernel only lets a GPL-compatible program call `bpf_probe_read_kernel`, which every
// `BPF_CORE_READ` above is. The crate stays MIT; this one file is offered under both.
char LICENSE[] SEC("license") = "Dual MIT/GPL";
