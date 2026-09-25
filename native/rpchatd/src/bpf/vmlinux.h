/* The slice of the kernel's types the IPC guard program reads, hand-written rather than
 * generated.
 *
 * `bpftool btf dump file /sys/kernel/btf/vmlinux format c` produces the same thing for every
 * type the kernel knows: 160k lines and five megabytes, regenerated per machine. This program
 * touches five structs and one field in each, so the whole file is written out instead — it
 * stays reviewable, and the build does not depend on the building machine's kernel.
 *
 * Every struct carries `preserve_access_index`, so each `->` through one emits a CO-RE
 * relocation: clang records "the field named `path` in the struct named `unix_sock`" and the
 * loader patches in the offset the *running* kernel's BTF gives. The offsets below are
 * therefore never used, and the members these definitions leave out do not matter. What must
 * be right is the spelling of each struct and field name, and the width of each scalar.
 */
#ifndef __VMLINUX_H__
#define __VMLINUX_H__

typedef signed char __s8;
typedef unsigned char __u8;
typedef short int __s16;
typedef short unsigned int __u16;
typedef int __s32;
typedef unsigned int __u32;
typedef long long int __s64;
typedef long long unsigned int __u64;

typedef __u8 u8;
typedef __u16 u16;
typedef __u32 u32;
typedef __u64 u64;
typedef __s32 s32;
typedef __s64 s64;

typedef __u32 dev_t;

/* Endian-tagged aliases: libbpf's helper prototypes name them, nothing here uses them. */
typedef __u16 __be16;
typedef __u16 __le16;
typedef __u32 __be32;
typedef __u32 __le32;
typedef __u64 __be64;
typedef __u32 __wsum;
typedef __u16 __sum16;

/* Only the four map types this program declares; the values are uapi and never change. */
enum bpf_map_type {
	BPF_MAP_TYPE_HASH = 1,
	BPF_MAP_TYPE_ARRAY = 2,
	BPF_MAP_TYPE_CGROUP_ARRAY = 8,
	BPF_MAP_TYPE_RINGBUF = 27,
};

/* Referenced only as pointers in libbpf's helper prototypes; never dereferenced here. */
struct bpf_map;
struct task_struct;
struct sk_buff;
struct sock;
struct socket;
struct vfsmount;
struct super_block;
struct inode;
struct dentry;

struct super_block {
	dev_t s_dev;
} __attribute__((preserve_access_index));

struct inode {
	long unsigned int i_ino;
	struct super_block *i_sb;
} __attribute__((preserve_access_index));

struct dentry {
	struct inode *d_inode;
} __attribute__((preserve_access_index));

struct path {
	struct vfsmount *mnt;
	struct dentry *dentry;
} __attribute__((preserve_access_index));

/* `struct unix_sock` starts with `struct sock sk`, which is why the hook's `struct sock *` is
 * castable to it. Only `path` — the filesystem node a bound socket was created at — is read. */
struct unix_sock {
	struct path path;
} __attribute__((preserve_access_index));

#endif /* __VMLINUX_H__ */
