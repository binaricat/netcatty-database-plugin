#!/bin/sh
set -eu

if [ -f /etc/bastion/authorized_key.pub ]; then
  cp /etc/bastion/authorized_key.pub /home/bastion/.ssh/authorized_keys
  chown bastion:bastion /home/bastion/.ssh/authorized_keys
  chmod 600 /home/bastion/.ssh/authorized_keys
fi

exec /usr/sbin/sshd -D -e
