# This is free software, licensed under the GNU General Public License v2.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-routelists
PKG_VERSION:=0.1.5
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=Aidar Garikhanov <vinfremo@gmail.com>

LUCI_TITLE:=Manage user route list files (domains/IP/CIDR) for ZeroBlock
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
