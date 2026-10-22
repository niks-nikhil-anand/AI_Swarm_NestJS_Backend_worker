#!/bin/sh
# Verification-only PKI: a throwaway CA, name-constrained to *.fixture.test, signs the
# fixture's certificate and is trusted only in the browser worker's NSS database. The CA
# key is deleted after signing; nothing here is used outside the verification stack.
set -eu
apk add --no-cache openssl nss-tools >/dev/null
work=$(mktemp -d)
cd "$work"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Swarm verification CA" \
  -keyout ca.key -out ca.crt \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -addext "nameConstraints=critical,permitted;DNS:fixture.test" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=forms.fixture.test" \
  -keyout server.key -out server.csr 2>/dev/null
cat > ext.cnf <<'EOF'
subjectAltName=DNS:forms.fixture.test,DNS:private.fixture.test
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 2 \
  -extfile ext.cnf -out server.crt 2>/dev/null
rm -f ca.key
cp server.crt server.key ca.crt /pki/
chmod 644 /pki/server.crt /pki/ca.crt
chmod 640 /pki/server.key
rm -rf /nssdb/* /nssdb/.[!.]* 2>/dev/null || true
certutil -N -d sql:/nssdb --empty-password
certutil -A -d sql:/nssdb -n swarm-verification-ca -t "C,," -i ca.crt
# The browser worker runs as the image's "node" user (uid 1000).
chown -R 1000:1000 /nssdb
rm -rf "$work"
echo "verification PKI ready"
