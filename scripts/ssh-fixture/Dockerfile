FROM alpine:3.22
RUN apk add --no-cache openssh-server git bash nodejs coreutils \
    && adduser -D -s /bin/bash soreno \
    && passwd -d soreno \
    && mkdir -p /home/soreno/.ssh /run/sshd \
    && chmod 700 /home/soreno/.ssh \
    && chown -R soreno:soreno /home/soreno/.ssh \
    && ssh-keygen -A \
    && printf '\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' >> /etc/ssh/sshd_config
COPY pi /usr/local/bin/pi
RUN chmod +x /usr/local/bin/pi && ln -s /usr/local/bin/pi /usr/local/bin/omp
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
