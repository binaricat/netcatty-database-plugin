FROM alpine:3.21

RUN apk add --no-cache openssh-server netcat-openbsd && \
    adduser -D -s /bin/sh bastion && \
    echo "bastion:bastion_pass" | chpasswd && \
    mkdir -p /home/bastion/.ssh /etc/bastion /run/sshd && \
    chown -R bastion:bastion /home/bastion/.ssh && \
    chmod 700 /home/bastion/.ssh && \
    ssh-keygen -A

RUN printf '%s\n' \
  'Port 22' \
  'ListenAddress 0.0.0.0' \
  'PermitRootLogin no' \
  'PubkeyAuthentication yes' \
  'PasswordAuthentication yes' \
  'AllowTcpForwarding yes' \
  'GatewayPorts yes' \
  'PermitOpen any' \
  'X11Forwarding no' \
  'UseDNS no' \
  'AuthorizedKeysFile /home/bastion/.ssh/authorized_keys' \
  > /etc/ssh/sshd_config

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
