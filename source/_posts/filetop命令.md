---
title: filetop命令
date: 2025-9-29 16:39:04
tags: [linux, filetop, 命令]
categories:
  - [linux,命令]
---
### 背景

创建10个10分区1副本的topic，同时对这10个topic进行生产，iostat显示的磁盘读在10MB左右，想搞清楚这个磁盘读是怎么回事，读的是哪些文件

### filetop命令简介

filetop命令可以很好的满足需求，是bcc-tools下面的一个工具。
<!--more-->
```shell
# 安装
yum install bcc-tools
# 使用
/usr/share/bcc/tools/filetop --help
```

参数说明：

```shell
  -a, --all-files       include non-regular file types (sockets, FIFOs, etc)
  -C, --noclear         don't clear the screen
  -r MAXROWS, --maxrows MAXROWS
                        maximum rows to print, default 20
  -s {all,reads,writes,rbytes,wbytes}, --sort {all,reads,writes,rbytes,wbytes}
                        sort column, default all
  -p PID, --pid PID     trace this PID only
```

使用示例：

```shell
[root@localhost ~]# /usr/share/bcc/tools/filetop -C -r 50 -s wbytes -p 404030 -a
TID     COMM             READS  WRITES R_Kb    W_Kb    T FILE
546313  kafka-request-h  0      33     0       332     R 00000000000000104125.log
546313  kafka-request-h  0      33     0       332     R 00000000000000104125.log
546313  kafka-request-h  0      33     0       332     R 00000000000000104125.log
546313  kafka-request-h  0      33     0       332     R 00000000000000104125.log
546313  kafka-request-h  0      32     0       322     R 00000000000000104125.log
546313  kafka-request-h  0      32     0       322     R 00000000000000104125.log
546313  kafka-request-h  0      32     0       322     R 00000000000000104125.log
546313  kafka-request-h  0      32     0       322     R 00000000000000104125.log
```

### 问题

在纯生产的时候，用filetop命令没有发现R_Kb高的，和iostat显示的10MB左右对不上。

进一步，在纯消费的时候，使用filetop命令，发现实际应该有170MB/s左右的读，但filetop总的读吞吐相加还不到1MB/s。

filetop命令实际是一个python脚本，里面调用了一些内核函数。详细解读如下：

```python
// ====================== eBPF C 部分 ======================
// 这些头在内核端编译：uapi/ptrace 用于 kprobe 上下文，blkdev 这里其实没用到块层字段
#include <uapi/linux/ptrace.h>
#include <linux/blkdev.h>

// 输出key：标识一次聚合的“对象（线程+文件）”
struct info_t {
    unsigned long inode;           // 文件 inode 号（标识文件对象）
    dev_t dev;                     // 设备号（此处取的是 i_rdev，常规文件一般用不上）
    u32 pid;                       // 这里的 pid 实际存 TID（低32位）
    u32 name_len;                  // 文件名长度（qstr.len）
    char comm[TASK_COMM_LEN];      // 任务名（进程名/线程名）
    // dentry->d_name.name 可能指向 d_iname（内联），所以长度按内联最大值限制
    char name[DNAME_INLINE_LEN];   // 文件“基名”（不含路径）
    char type;                     // 'R' 常规文件，'S' socket，'O' 其他
};

// 输出值：累加的计数/字节
struct val_t {
    u64 reads;                     // 读次数
    u64 writes;                    // 写次数
    u64 rbytes;                    // 读字节
    u64 wbytes;                    // 写字节
};

// eBPF 哈希表：key=info_t，value=val_t
BPF_HASH(counts, struct info_t, struct val_t);

// 公共入口：vfs_read/vfs_write 统一走这里，is_read 区分读写
static int do_entry(struct pt_regs *ctx, struct file *file,
    char __user *buf, size_t count, int is_read)
{
    // 取 TGID（高32位），用于过滤
    u32 tgid = bpf_get_current_pid_tgid() >> 32;
    if (TGID_FILTER)                  // 由用户态替换成“tgid != 指定值”或“0”
        return 0;

    // 取低 32 位 TID，作为 key 的 pid 字段（其实是 TID）
    u32 pid = bpf_get_current_pid_tgid();

    // 通过 struct file 提取 dentry / inode 信息
    struct dentry *de = file->f_path.dentry;
    int mode = file->f_inode->i_mode; // 决定文件类型的 mode 位
    struct qstr d_name = de->d_name;  // 基名（qstr含指针与长度）

    // 没文件名，或被类型过滤，就跳过
    if (d_name.len == 0 || TYPE_FILTER)   // TYPE_FILTER 由用户态替换：默认跳过非 REG
        return 0;

    // 组织 key
    struct info_t info = {
        .pid = pid,
        .inode = file->f_inode->i_ino,    // inode 号
        .dev = file->f_inode->i_rdev,     // 设备（对常规文件通常无意义）
    };
    bpf_get_current_comm(&info.comm, sizeof(info.comm)); // 任务名
    info.name_len = d_name.len;
    // 安全地从内核拷贝文件名到 key（限制了内联长度）
    bpf_probe_read_kernel(&info.name, sizeof(info.name), d_name.name);

    // 判类型：常规文件 / 套接字 / 其他
    if (S_ISREG(mode)) {
        info.type = 'R';
    } else if (S_ISSOCK(mode)) {
        info.type = 'S';
    } else {
        info.type = 'O';
    }

    // 查找或初始化 value，然后累加计数
    struct val_t *valp, zero = {};
    valp = counts.lookup_or_try_init(&info, &zero);
    if (valp) {
        if (is_read) {
            valp->reads++;
            valp->rbytes += count;   // 这里记的是“请求读的字节数”
        } else {
            valp->writes++;
            valp->wbytes += count;   // 同理：请求写的字节数
        }
    }
    return 0;
}

// vfs_read 的 kprobe 入口包装（只列出用到的前三个参数）
int trace_read_entry(struct pt_regs *ctx, struct file *file,
    char __user *buf, size_t count)
{
    return do_entry(ctx, file, buf, count, 1);
}

// vfs_write 的 kprobe 入口包装
int trace_write_entry(struct pt_regs *ctx, struct file *file,
    char __user *buf, size_t count)
{
    return do_entry(ctx, file, buf, count, 0);
}

# ====================== Python / 用户态部分 ======================
from bpfcc import BPF
from time import sleep, strftime
import argparse
from subprocess import call

# ---------- 命令行参数 ----------
# -a/--all-files    ：默认只数常规文件，加这个就把 socket/FIFO 等也统计
# -C/--noclear      ：不要每次刷新都清屏
# -r/--maxrows      ：显示的最大行数（默认20）
# -s/--sort         ：排序列（all=总和、reads/writes/rbytes/wbytes）
# -p/--pid <PID>    ：只跟踪这个 TGID（进程）
# interval [count]  ：刷新间隔秒（默认1），输出次数（默认很大，近似无限）

# 省略：argparse 的定义（与上面说明一致）
# ...

# ---------- 根据参数拼 eBPF 源码里的“宏开关” ----------
if args.tgid:
    # 只跟踪这个 TGID（高32位）
    bpf_text = bpf_text.replace('TGID_FILTER', 'tgid != %d' % args.tgid)
else:
    bpf_text = bpf_text.replace('TGID_FILTER', '0')

if args.all_files:
    # 不做类型过滤
    bpf_text = bpf_text.replace('TYPE_FILTER', '0')
else:
    # 默认：过滤掉非常规文件（留下 Regular File）
    bpf_text = bpf_text.replace('TYPE_FILTER', '!S_ISREG(mode)')

# --ebpf 输出内核端 C 程序并退出（用于调试查看）
if debug or args.ebpf:
    print(bpf_text)
    if args.ebpf:
        exit()

# ---------- 加载 eBPF 并挂 kprobe ----------
b = BPF(text=bpf_text)
b.attach_kprobe(event="vfs_read",  fn_name="trace_read_entry")
b.attach_kprobe(event="vfs_write", fn_name="trace_write_entry")

DNAME_INLINE_LEN = 32  # 与内核端保持一致，用于截断显示

print('Tracing... Output every %d secs. Hit Ctrl-C to end' % interval)

# 排序函数：-s all = rbytes+wbytes+reads+writes 之和；否则按指定字段
def sort_fn(item):
    k, v = item
    if args.sort == "all":
        return v.rbytes + v.wbytes + v.reads + v.writes
    else:
        return getattr(v, args.sort)

# ---------- 周期性地拉取 map、打印、清空 ----------
while 1:
    try:
        sleep(interval)
    except KeyboardInterrupt:
        # Ctrl-C 后打印一轮就退出
        exiting = 1

    # 头部信息：loadavg 与表头
    if clear:
        call("clear")
    else:
        print()
    with open("/proc/loadavg") as stats:
        print("%-8s loadavg: %s" % (strftime("%H:%M:%S"), stats.read()))
    print("%-7s %-16s %-6s %-6s %-7s %-7s %1s %s" %
          ("TID", "COMM", "READS", "WRITES", "R_Kb", "W_Kb", "T", "FILE"))

    # 从 eBPF map 取出所有条目，按排序规则逆序打印，最多 maxrows 行
    counts = b.get_table("counts")
    line = 0
    for k, v in reversed(sorted(counts.items(), key=sort_fn)):
        # 文件名是 d_name 基名，可能被截断
        name = k.name.decode('utf-8', 'replace')
        if k.name_len > DNAME_INLINE_LEN:
            name = name[:-3] + "..."

        print("%-7d %-16s %-6d %-6d %-7d %-7d %1s %s" %
              (k.pid,                                 # 注意：这里显示的是 TID
               k.comm.decode('utf-8', 'replace'),
               v.reads, v.writes,
               v.rbytes // 1024, v.wbytes // 1024,   # 以 KiB 打印
               k.type.decode('utf-8', 'replace'),
               name))

        line += 1
        if line >= maxrows:
            break

    counts.clear()  # 清空形成“滑动窗口”

    countdown -= 1
    if exiting or countdown == 0:
        print("Detaching...")
        exit()
```

### 改进

对于纯消费，但是filetop的读吞吐和实际读吞吐对不上的原因，是因为kafka用了FileChannel.transferTo()，底层用的是零拷贝，不会走vfs_read，调用的是do_splice_to / iter_file_splice_read或do_sendfile。将这3个内核纳入统计后，正常，修改后代码如下：

```python
#!/usr/bin/python3
# @lint-avoid-python-3-compatibility-imports
#
# filetop  file reads and writes by process (extended for zero-copy read paths).
#          For Linux, uses BCC, eBPF.
#
# USAGE: filetop.py [-h] [-C] [-r MAXROWS] [interval] [count]
#
# This version adds coverage for sendfile/splice-based zero copy reads:
#   - do_splice_to
#   - iter_file_splice_read   (newer kernels)
#   - do_sendfile             (older kernels / some paths)
#
# Copyright 2016 Netflix, Inc.
# Apache License 2.0
# 06-Feb-2016   Brendan Gregg   Created this.
# 29-Sep-2025   yxz             Added splice/sendfile hooks & robust attaches.

from __future__ import print_function
from bpfcc import BPF
from time import sleep, strftime
import argparse
from subprocess import call

# arguments
examples = """examples:
    ./filetop            # file I/O top, 1 second refresh
    ./filetop -C         # don't clear the screen
    ./filetop -p 181     # PID 181 only
    ./filetop 5          # 5 second summaries
    ./filetop 5 10       # 5 second summaries, 10 times only
"""
parser = argparse.ArgumentParser(
    description="File reads and writes by process (covers read(), write(), sendfile/splice)",
    formatter_class=argparse.RawDescriptionHelpFormatter,
    epilog=examples)
parser.add_argument("-a", "--all-files", action="store_true",
    help="include non-regular file types (sockets, FIFOs, etc)")
parser.add_argument("-C", "--noclear", action="store_true",
    help="don't clear the screen")
parser.add_argument("-r", "--maxrows", default=20,
    help="maximum rows to print, default 20")
parser.add_argument("-s", "--sort", default="all",
    choices=["all", "reads", "writes", "rbytes", "wbytes"],
    help="sort column, default all")
parser.add_argument("-p", "--pid", type=int, metavar="PID", dest="tgid",
    help="trace this PID only")
parser.add_argument("interval", nargs="?", default=1,
    help="output interval, in seconds")
parser.add_argument("count", nargs="?", default=99999999,
    help="number of outputs")
parser.add_argument("--ebpf", action="store_true",
    help=argparse.SUPPRESS)
args = parser.parse_args()
interval = int(args.interval)
countdown = int(args.count)
maxrows = int(args.maxrows)
clear = not int(args.noclear)
debug = 0

# linux stats
loadavg = "/proc/loadavg"

# define BPF program
bpf_text = r"""
#include <uapi/linux/ptrace.h>
#include <linux/blkdev.h>
#include <linux/fs.h>
#include <linux/dcache.h>

struct info_t {
    unsigned long inode;
    dev_t dev;
    u32 pid;        // TID actually, for compatibility with original script
    u32 name_len;
    char comm[TASK_COMM_LEN];
    char name[DNAME_INLINE_LEN];
    char type;
};

struct val_t {
    u64 reads;
    u64 writes;
    u64 rbytes;
    u64 wbytes;
};

BPF_HASH(counts, struct info_t, struct val_t);

// Common helper: account a file I/O on "file *" with given read/write and size
static __always_inline int account_file_io(struct pt_regs *ctx, struct file *file, size_t count, int is_read)
{
    u32 tgid = bpf_get_current_pid_tgid() >> 32;
    if (TGID_FILTER)
        return 0;

    u32 pid = bpf_get_current_pid_tgid();

    // skip I/O lacking a filename
    struct dentry *de = file->f_path.dentry;
    if (!de)
        return 0;

    int mode = file->f_inode->i_mode;
    struct qstr d_name = de->d_name;
    if (d_name.len == 0 || TYPE_FILTER)
        return 0;

    // store counts and sizes by pid & file
    struct info_t info = {};
    info.pid = pid;
    info.inode = file->f_inode->i_ino;
    // keep original semantics; many scripts use i_rdev here
    info.dev = file->f_inode->i_rdev;

    bpf_get_current_comm(&info.comm, sizeof(info.comm));
    info.name_len = d_name.len;
    bpf_probe_read_kernel(&info.name, sizeof(info.name), d_name.name);

    if (S_ISREG(mode)) {
        info.type = 'R';
    } else if (S_ISSOCK(mode)) {
        info.type = 'S';
    } else {
        info.type = 'O';
    }

    struct val_t zero = {};
    struct val_t *valp = counts.lookup_or_try_init(&info, &zero);
    if (valp) {
        if (is_read) {
            __sync_fetch_and_add(&valp->reads, 1);
            __sync_fetch_and_add(&valp->rbytes, count);
        } else {
            __sync_fetch_and_add(&valp->writes, 1);
            __sync_fetch_and_add(&valp->wbytes, count);
        }
    }
    return 0;
}

// Original vfs_read/vfs_write hooks
int trace_read_entry(struct pt_regs *ctx, struct file *file,
    char __user *buf, size_t count)
{
    return account_file_io(ctx, file, count, 1);
}

int trace_write_entry(struct pt_regs *ctx, struct file *file,
    char __user *buf, size_t count)
{
    return account_file_io(ctx, file, count, 0);
}

// -------- Zero-copy read paths: splice/sendfile family ----------

// do_splice_to(struct file *in, loff_t *ppos, struct pipe_inode_info *pipe, size_t len, unsigned int flags)
int trace_do_splice_to(struct pt_regs *ctx, struct file *in, void *ppos, void *pipe, size_t len, unsigned int flags)
{
    // This is a "read" from file to pipe/socket
    return account_file_io(ctx, in, len, 1);
}

// iter_file_splice_read(struct file *in, loff_t *ppos, struct pipe_inode_info *pipe, size_t len, unsigned int flags)
int trace_iter_file_splice_read(struct pt_regs *ctx, struct file *in, void *ppos, void *pipe, size_t len, unsigned int flags)
{
    return account_file_io(ctx, in, len, 1);
}

// do_sendfile(out, in, ppos, count) on some kernels; we only care about the "in" file and count
int trace_do_sendfile(struct pt_regs *ctx, struct file *out, struct file *in, void *ppos, size_t count)
{
    return account_file_io(ctx, in, count, 1);
}
"""

if args.tgid:
    bpf_text = bpf_text.replace('TGID_FILTER', 'tgid != %d' % args.tgid)
else:
    bpf_text = bpf_text.replace('TGID_FILTER', '0')

if args.all_files:
    bpf_text = bpf_text.replace('TYPE_FILTER', '0')
else:
    bpf_text = bpf_text.replace('TYPE_FILTER', '!S_ISREG(mode)')

if debug or args.ebpf:
    print(bpf_text)
    if args.ebpf:
        exit()

# initialize BPF
b = BPF(text=bpf_text)

# Attach helpers with graceful fallback (kernels may lack some symbols)
def try_attach_kprobe(sym, fn):
    try:
        b.attach_kprobe(event=sym, fn_name=fn)
        return True
    except Exception as e:
        # silently skip; user may run different kernel
        return False

# Original read/write (these should exist on most kernels)
try_attach_kprobe("vfs_read", "trace_read_entry")
try_attach_kprobe("vfs_write", "trace_write_entry")

# Zero-copy read paths (best-effort attach)
zc_syms = [
    ("do_splice_to", "trace_do_splice_to"),
    ("iter_file_splice_read", "trace_iter_file_splice_read"),
    ("do_sendfile", "trace_do_sendfile"),
]
zc_attached = []
for sym, fn in zc_syms:
    if try_attach_kprobe(sym, fn):
        zc_attached.append(sym)

DNAME_INLINE_LEN = 32  # linux/dcache.h

print('Tracing... Output every %d secs. Hit Ctrl-C to end' % interval)
if zc_attached:
    print("Zero-copy read hooks attached:", ", ".join(zc_attached))
else:
    print("Warning: zero-copy read hooks not attached (kernel symbols not found). "
          "Read throughput may be underreported.")

def sort_fn(counts):
    if args.sort == "all":
        return (counts[1].rbytes + counts[1].wbytes + counts[1].reads + counts[1].writes)
    else:
        return getattr(counts[1], args.sort)

# output
exiting = 0
while 1:
    try:
        sleep(interval)
    except KeyboardInterrupt:
        exiting = 1

    # header
    if clear:
        call("clear")
    else:
        print()
    with open(loadavg) as stats:
        print("%-8s loadavg: %s" % (strftime("%H:%M:%S"), stats.read()))
    print("%-7s %-16s %-6s %-6s %-7s %-7s %1s %s" % ("TID", "COMM",
        "READS", "WRITES", "R_Kb", "W_Kb", "T", "FILE"))

    # by-TID output
    counts = b.get_table("counts")
    line = 0
    for k, v in reversed(sorted(counts.items(), key=sort_fn)):
        name = k.name.decode('utf-8', 'replace')
        if k.name_len > DNAME_INLINE_LEN:
            name = name[:-3] + "..."

        print("%-7d %-16s %-6d %-6d %-7d %-7d %1s %s" % (
            k.pid,
            k.comm.decode('utf-8', 'replace'),
            v.reads, v.writes,
            v.rbytes // 1024, v.wbytes // 1024,
            k.type.decode('utf-8', 'replace'),
            name))

        line += 1
        if line >= maxrows:
            break
    counts.clear()

    countdown -= 1
    if exiting or countdown == 0:
        print("Detaching...")
        exit()

```

用上面的代码解决了纯消费时对不上的问题，但是纯生产时，用filetop看，读仍旧是0。原因大概率是在写的时候，磁盘的预读。（待深入研究）

