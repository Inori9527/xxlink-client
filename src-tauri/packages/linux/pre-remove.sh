#!/bin/bash
/usr/bin/xxlink-service-uninstall

. /etc/os-release

if [ "$ID" = "deepin" ]; then
    if [ -f "/usr/share/applications/xxlink.desktop" ]; then
        echo "Removing deepin desktop file"
        rm -vf "/usr/share/applications/xxlink.desktop"
    fi
fi

