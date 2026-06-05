---
title: Lightsail Ubuntu 搭建 TUIC 服务端
date: 2026-06-05 11:40:00
tags: [VPN, AWS, Lightsail, Ubuntu, TUIC, sing-box]
categories:
  - [网络]
---

这篇记录一套可复制的 TUIC 服务端部署流程，目标环境是 AWS Lightsail 东京节点，系统选择 Ubuntu 24.04 LTS 或 Ubuntu 22.04 LTS。

这里不用早期的 `tuic-server` 参考实现，而是用 `sing-box` 跑 TUIC inbound。原因是 sing-box 同时支持服务端、客户端和配置校验，后面如果要做多线路、分流、DNS 或迁移到其他协议，维护成本更低。

<!-- more -->

## 0. 部署前准备

这篇假设已经有一台 Lightsail 实例：

```text
系统: Ubuntu 24.04 LTS，或 Ubuntu 22.04 LTS
区域: 东京
用途: 自用测试节点
协议: TUIC over QUIC/UDP
服务端程序: sing-box
```

还需要准备一个域名，例如：

```text
tuic.example.com
```

把这个域名的 `A` 记录解析到 Lightsail 实例的公网 IP。建议在 Lightsail 上绑定静态 IP，避免实例重启后公网 IP 变化。

如果域名托管在 Cloudflare，先把这条记录设置为 **DNS only**，不要开启代理。也就是灰色云朵，不是橙色云朵。TUIC 走 UDP，不能让普通 Cloudflare HTTP 代理接管。

## 1. Lightsail 防火墙

在 Lightsail 控制台里打开实例的 Networking/网络配置，至少放行：

```text
TCP 22    SSH 登录
TCP 80    Let's Encrypt 申请证书
UDP 443   TUIC 服务端口
```

如果后面改成其他 TUIC 端口，比如 `8443`，也要放行对应的 UDP 端口。

注意：TUIC 是 UDP 协议。只放行 TCP 443 没用。

## 2. 一键安装脚本

SSH 登录服务器后，先切到 root：

```bash
sudo -i
```

然后复制下面这段脚本。只需要改最上面的 `DOMAIN` 和 `EMAIL`。

```bash
cat > /root/install-tuic-sing-box.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

# ====== 必改项 ======
DOMAIN="tuic.example.com"
EMAIL="you@example.com"

# ====== 可选项 ======
TUIC_PORT="443"
CERT_MODE="letsencrypt"   # letsencrypt 或 self-signed
CONGESTION_CONTROL="bbr"  # bbr / cubic / new_reno

if [ "$EUID" -ne 0 ]; then
  echo "请使用 root 执行：sudo -i 后再运行脚本"
  exit 1
fi

if [ "$DOMAIN" = "tuic.example.com" ] || [ "$EMAIL" = "you@example.com" ]; then
  echo "请先编辑脚本顶部的 DOMAIN 和 EMAIL"
  exit 1
fi

echo "[1/8] 安装基础依赖"
apt-get update
apt-get install -y ca-certificates curl wget jq tar openssl socat cron ufw

echo "[2/8] 开启基础网络优化"
cat > /etc/sysctl.d/99-tuic-network.conf <<'SYSCTL'
net.core.default_qdisc=fq
net.ipv4.tcp_congestion_control=bbr
net.ipv4.ip_local_port_range=10240 65535
net.ipv4.tcp_fastopen=3
SYSCTL
sysctl --system >/dev/null

echo "[3/8] 安装 sing-box"
SB_TAG="$(curl -fsSL https://api.github.com/repos/SagerNet/sing-box/releases/latest | jq -r .tag_name)"
SB_VERSION="${SB_TAG#v}"

case "$(uname -m)" in
  x86_64) SB_ARCH="amd64" ;;
  aarch64|arm64) SB_ARCH="arm64" ;;
  *) echo "暂不支持当前架构：$(uname -m)"; exit 1 ;;
esac

SB_URL="https://github.com/SagerNet/sing-box/releases/download/${SB_TAG}/sing-box-${SB_VERSION}-linux-${SB_ARCH}.tar.gz"
TMP_DIR="$(mktemp -d)"
curl -fL "$SB_URL" -o "$TMP_DIR/sing-box.tar.gz"
tar -xzf "$TMP_DIR/sing-box.tar.gz" -C "$TMP_DIR"
install -m 0755 "$TMP_DIR/sing-box-${SB_VERSION}-linux-${SB_ARCH}/sing-box" /usr/local/bin/sing-box
rm -rf "$TMP_DIR"

mkdir -p /etc/sing-box

echo "[4/8] 生成或复用 TUIC 账号"
ENV_FILE="/etc/sing-box/tuic.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
else
  TUIC_UUID="$(cat /proc/sys/kernel/random/uuid)"
  TUIC_PASSWORD="$(openssl rand -base64 24 | tr -d '\n')"
  cat > "$ENV_FILE" <<ENV
DOMAIN="$DOMAIN"
TUIC_PORT="$TUIC_PORT"
TUIC_UUID="$TUIC_UUID"
TUIC_PASSWORD="$TUIC_PASSWORD"
ENV
  chmod 600 "$ENV_FILE"
fi

echo "[5/8] 准备 TLS 证书"
if [ "$CERT_MODE" = "letsencrypt" ]; then
  if [ ! -x /root/.acme.sh/acme.sh ]; then
    curl https://get.acme.sh | sh -s email="$EMAIL"
  fi
  /root/.acme.sh/acme.sh --set-default-ca --server letsencrypt
  systemctl stop sing-box >/dev/null 2>&1 || true
  /root/.acme.sh/acme.sh --issue --standalone -d "$DOMAIN" --keylength ec-256
  /root/.acme.sh/acme.sh --install-cert -d "$DOMAIN" --ecc \
    --fullchain-file /etc/sing-box/cert.pem \
    --key-file /etc/sing-box/key.pem \
    --reloadcmd "systemctl restart sing-box"
else
  openssl ecparam -genkey -name prime256v1 -out /etc/sing-box/key.pem
  openssl req -new -x509 -days 3650 \
    -key /etc/sing-box/key.pem \
    -out /etc/sing-box/cert.pem \
    -subj "/CN=${DOMAIN}"
fi
chmod 600 /etc/sing-box/key.pem
chmod 644 /etc/sing-box/cert.pem

echo "[6/8] 写入 sing-box TUIC 配置"
cat > /etc/sing-box/config.json <<CONFIG
{
  "log": {
    "level": "info",
    "timestamp": true
  },
  "inbounds": [
    {
      "type": "tuic",
      "tag": "tuic-in",
      "listen": "::",
      "listen_port": ${TUIC_PORT},
      "users": [
        {
          "name": "main",
          "uuid": "${TUIC_UUID}",
          "password": "${TUIC_PASSWORD}"
        }
      ],
      "congestion_control": "${CONGESTION_CONTROL}",
      "auth_timeout": "3s",
      "zero_rtt_handshake": false,
      "heartbeat": "10s",
      "tls": {
        "enabled": true,
        "server_name": "${DOMAIN}",
        "certificate_path": "/etc/sing-box/cert.pem",
        "key_path": "/etc/sing-box/key.pem"
      }
    }
  ],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    }
  ],
  "route": {
    "final": "direct"
  }
}
CONFIG

/usr/local/bin/sing-box check -c /etc/sing-box/config.json

echo "[7/8] 写入 systemd 服务"
cat > /etc/systemd/system/sing-box.service <<'SERVICE'
[Unit]
Description=sing-box service
Documentation=https://sing-box.sagernet.org/
After=network.target nss-lookup.target
Wants=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/sing-box run -c /etc/sing-box/config.json
Restart=on-failure
RestartSec=5s
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable --now sing-box

echo "[8/8] 配置本机防火墙"
ufw allow OpenSSH >/dev/null || true
ufw allow 80/tcp >/dev/null || true
ufw allow "${TUIC_PORT}/udp" >/dev/null || true
ufw --force enable >/dev/null || true

cat > /root/tuic-client-sing-box.json <<CLIENT
{
  "type": "tuic",
  "tag": "tuic-out",
  "server": "${DOMAIN}",
  "server_port": ${TUIC_PORT},
  "uuid": "${TUIC_UUID}",
  "password": "${TUIC_PASSWORD}",
  "congestion_control": "${CONGESTION_CONTROL}",
  "udp_relay_mode": "native",
  "zero_rtt_handshake": false,
  "heartbeat": "10s",
  "tls": {
    "enabled": true,
    "server_name": "${DOMAIN}",
    "insecure": false
  }
}
CLIENT

if [ "$CERT_MODE" = "self-signed" ]; then
  sed -i 's/"insecure": false/"insecure": true/' /root/tuic-client-sing-box.json
fi

echo
echo "安装完成"
echo "服务状态：systemctl status sing-box --no-pager"
echo "查看日志：journalctl -u sing-box -f"
echo "客户端配置：/root/tuic-client-sing-box.json"
echo
cat /root/tuic-client-sing-box.json
EOF

chmod +x /root/install-tuic-sing-box.sh
/root/install-tuic-sing-box.sh
```

脚本跑完后，会输出一段客户端配置，同时也会保存在：

```bash
/root/tuic-client-sing-box.json
```

## 3. 验证服务端

看服务状态：

```bash
systemctl status sing-box --no-pager
```

看实时日志：

```bash
journalctl -u sing-box -f
```

确认监听端口：

```bash
ss -lunpt | grep ':443'
```

检查 BBR：

```bash
sysctl net.ipv4.tcp_congestion_control
sysctl net.core.default_qdisc
```

如果看到：

```text
net.ipv4.tcp_congestion_control = bbr
net.core.default_qdisc = fq
```

说明基础网络参数已生效。

## 4. 客户端配置

脚本会生成 sing-box outbound 片段：

```bash
cat /root/tuic-client-sing-box.json
```

形态大概是：

```json
{
  "type": "tuic",
  "tag": "tuic-out",
  "server": "tuic.example.com",
  "server_port": 443,
  "uuid": "自动生成的 UUID",
  "password": "自动生成的密码",
  "congestion_control": "bbr",
  "udp_relay_mode": "native",
  "zero_rtt_handshake": false,
  "heartbeat": "10s",
  "tls": {
    "enabled": true,
    "server_name": "tuic.example.com",
    "insecure": false
  }
}
```

如果使用的是自签证书，客户端需要设置：

```json
"insecure": true
```

正式使用建议走 Let's Encrypt 证书，不要长期依赖自签证书。

## 5. 常见问题

### 连不上

先看 Lightsail 控制台有没有开放 `UDP 443`。TUIC 是 UDP，不是 TCP。

再看服务端日志：

```bash
journalctl -u sing-box -n 100 --no-pager
```

如果日志里没有任何连接记录，通常是安全组、防火墙、运营商 UDP 或域名解析问题。

### 证书申请失败

检查三点：

```text
1. 域名 A 记录是否指向 Lightsail 公网 IP
2. Lightsail 是否开放 TCP 80
3. Cloudflare 是否关闭代理，只保留 DNS only
```

Let's Encrypt HTTP-01 校验需要访问服务器的 TCP 80。

### 速度不稳定

TUIC 解决的是传输协议层问题，不等于绕过所有线路拥塞。测试时要分开看：

```text
非高峰速度
晚高峰速度
家宽和手机热点差异
443 旧线路和 TUIC 新线路差异
```

如果只有晚高峰慢，大概率还是跨境链路拥塞。

## 6. 维护命令

重启服务：

```bash
systemctl restart sing-box
```

停止服务：

```bash
systemctl stop sing-box
```

查看配置：

```bash
cat /etc/sing-box/config.json
```

校验配置：

```bash
sing-box check -c /etc/sing-box/config.json
```

查看账号：

```bash
cat /etc/sing-box/tuic.env
```

重新生成账号时，先备份旧配置，再删除 env 文件重跑脚本：

```bash
cp /etc/sing-box/tuic.env /root/tuic.env.bak.$(date +%F)
rm /etc/sing-box/tuic.env
/root/install-tuic-sing-box.sh
```

## 7. 参考

TUIC 协议本身是面向 TCP/UDP 转发的 QUIC 代理协议，官方仓库说明了它的目标：0-RTT、UDP 转发、QUIC 拥塞控制和连接迁移等能力。sing-box 官方文档中，TUIC inbound 需要 `users`、`congestion_control` 和 `tls` 等字段；TUIC outbound 需要 `server`、`server_port`、`uuid`、`password`、`udp_relay_mode` 和 `tls` 等字段。

参考链接：

- [TUIC Protocol GitHub](https://github.com/tuic-protocol/tuic)
- [TUIC releases](https://github.com/tuic-protocol/tuic/releases)
- [sing-box TUIC inbound](https://sing-box.sagernet.org/configuration/inbound/tuic/)
- [sing-box TUIC outbound](https://sing-box.sagernet.org/configuration/outbound/tuic/)
- [sing-box configuration](https://sing-box.sagernet.org/configuration/)
