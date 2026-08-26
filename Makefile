# This is free software, licensed under the GNU General Public License v2.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-routelists
PKG_VERSION:=0.1.6
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=Aidar Garikhanov <a1d4r@yandex.ru>

LUCI_TITLE:=Manage user route list files (domains/IP/CIDR) for ZeroBlock
LUCI_DESCRIPTION:=LuCI app for maintaining local user list files (domains / IPv4 / IPv6 / CIDR) \
	in /etc/user-lists for ZeroBlock: list table, modal editor with per-line validation \
	and one-click apply via the ZeroBlock ubus reload. No own backend — uses only the \
	stock rpcd file plugin and uci RPC.
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
