#!/bin/sh
# Replace the carried bqto Pro binaries with those of a paid release in pilef-co/bqto-pro-releases,
# checked against that release's checksums.txt. Without a tag, it carries the release in
# pro-checksums.txt again, so `git diff --exit-code bin/` proves bin/ matches it,
# and it fails when bin/ carries no bqto Pro.
# Usage: bin/update-pro.sh [v0.12.0]
set -eu
cd "$(dirname "$0")"
if [ -z "${1:-}" ] && [ ! -f pro-checksums.txt ]; then
	for f in bqto-pro_linux_*; do
		if [ -e "$f" ]; then
			echo "error: bin/$f has no pro-checksums.txt to check it against; run bin/update-pro.sh with its tag" >&2
			exit 1
		fi
	done
	echo "error: bin/ carries no bqto Pro, so edition: pro would fail; run bin/update-pro.sh with a bqto Pro release tag" >&2
	exit 1
fi
tag=${1:-v$(sed -n 's/^[0-9a-f]\{64\}  bqto-pro_\([0-9][0-9.]*\)_linux_amd64\.tar\.gz$/\1/p' pro-checksums.txt)}
if ! printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+'; then
	echo "error: $tag is not a bqto Pro release tag such as v0.12.0" >&2
	exit 1
fi
v=${tag#v}
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
gh release download "$tag" -R pilef-co/bqto-pro-releases -D "$dir" -p checksums.txt -p "bqto-pro_${v}_linux_*.tar.gz"
for arch in amd64 arm64; do
	archive=bqto-pro_${v}_linux_$arch.tar.gz
	want=$(awk -v f="$archive" '$2 == f { print $1 }' "$dir/checksums.txt")
	got=$( (sha256sum "$dir/$archive" 2>/dev/null || shasum -a 256 "$dir/$archive") | cut -d' ' -f1)
	if [ -z "$want" ] || [ "$want" != "$got" ]; then
		echo "error: $archive does not match the checksums.txt of $tag" >&2
		exit 1
	fi
	tar -xzf "$dir/$archive" -C "$dir" bqto
	mv "$dir/bqto" "bqto-pro_linux_$arch"
	chmod 755 "bqto-pro_linux_$arch"
done
cp "$dir/checksums.txt" pro-checksums.txt
echo "bin/ carries bqto Pro $tag"
