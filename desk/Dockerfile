FROM dorowu/ubuntu-desktop-lxde-vnc:latest

ENV DEBIAN_FRONTEND=noninteractive
RUN rm -f /etc/apt/sources.list.d/google-chrome*.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends wget ca-certificates xdotool gnupg socat && \
    wget -O /tmp/google-chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    apt-get install -y --no-install-recommends /tmp/google-chrome.deb && \
    rm -f /tmp/google-chrome.deb && \
    rm -rf /var/lib/apt/lists/*
