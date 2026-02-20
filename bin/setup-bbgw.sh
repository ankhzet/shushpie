#!/usr/bin/env bash

set -e

echo "📡 Enabling WiFi..."

sudo systemctl enable connman
sudo systemctl start connman

echo "🔎 Scanning WiFi networks..."
sudo connmanctl enable wifi
sudo connmanctl scan wifi

sleep 3

echo "Available networks:"
sudo connmanctl services

echo
echo "👉 Copy the wifi_xxxxx_managed_psk identifier above."
read -p "Enter WiFi service identifier: " SERVICE

sudo connmanctl agent on
sudo connmanctl connect "$SERVICE"

echo "🖥 Setting hostname to bbgw..."

sudo hostnamectl set-hostname bbgw

sudo sed -i 's/^127.0.1.1.*/127.0.1.1       bbgw.localdomain bbgw/' /etc/hosts

echo "🌐 Installing Avahi (mDNS)..."

sudo apt update
sudo apt install -y avahi-daemon
sudo systemctl enable avahi-daemon
sudo systemctl start avahi-daemon

echo
echo "✅ Done."
echo "Rebooting..."

sudo reboot

# sudo su
# echo 48 > /sys/class/gpio/export
# echo out > /sys/class/gpio/gpio48/direction
# echo 1 > /sys/class/gpio/gpio48/value
# echo 0 > /sys/class/gpio/gpio48/value

#  i2cdetect -r -y 2
# /opt/scripts/device/bone/capes/cape_eeprom_check.sh
