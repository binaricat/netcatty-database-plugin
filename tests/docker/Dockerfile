# Real distribution packages, not protocol mocks. Build/run is a separate authorized step.
FROM debian:bookworm-slim
RUN printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d && chmod 755 /usr/sbin/policy-rc.d \
    && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    openssh-server redis-server postgresql mariadb-server openssl ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash fixture \
    && mkdir -p /run/sshd /run/fixture /home/fixture/.ssh \
    && chmod 700 /home/fixture/.ssh \
    && chown fixture:fixture /home/fixture/.ssh \
    && rm -f /etc/ssh/ssh_host_* \
    && pg_dropcluster --stop 15 main
COPY entrypoint.sh /usr/local/bin/fixture-entrypoint
RUN chmod 755 /usr/local/bin/fixture-entrypoint
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/fixture-entrypoint"]
