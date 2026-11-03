Name: crewkite
Version: @VERSION@
Release: 1
Summary: Desktop workspace for supervised coding
License: Apache-2.0
URL: https://github.com/rjk6831/crewkite
BuildArch: @ARCH@
@REQUIRES@

# The common stage hashes final executables. RPM must preserve those exact bytes.
%global __os_install_post %{nil}
%global _build_id_links none
AutoReqProv: no

%description
CrewKite keeps supervised coding threads and their workspace state on this computer.

%install
mkdir -p %{buildroot}
cp -a "%{payload_root}/opt" "%{buildroot}/"
cp -a "%{payload_root}/usr" "%{buildroot}/"

%files
%defattr(-,root,root,-)
/opt/crewkite
/usr/bin/crewkite
/usr/share/applications/crewkite.desktop
/usr/share/icons/hicolor/256x256/apps/crewkite.png
