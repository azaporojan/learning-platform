# =============================================================================
# Learning Platform runner: one image, three roles
#   node src/runner.js   HTTP API the platform calls (no Docker access)
#   node src/gate.js     the only process with the Docker socket; creates sandboxes from this image
#   java lp.Kernel ...   the sandbox itself (JShell notebooks, JUnit checks)
# The gate starts sandboxes from the image its own container runs, so the host already has it
# whenever Dokploy has pulled the runner. See runner/README.md.
# =============================================================================

# --- Test libraries, pinned by checksum ---
FROM eclipse-temurin:21-jdk-jammy AS libs
ADD --chmod=0644 --checksum=sha256:b016ef6b1c3454d6d7c2c88ce081dabf289699686af6622d6e4e2e1b54b4a2fc \
    https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/1.11.4/junit-platform-console-standalone-1.11.4.jar /opt/lp/libs/
ADD --chmod=0644 --checksum=sha256:5b8a26205f6d5ea60ad9ce65ce4a40a2afe4c48abeec61bd0740a088c24e89f5 \
    https://repo1.maven.org/maven2/org/assertj/assertj-core/3.27.3/assertj-core-3.27.3.jar /opt/lp/libs/
ADD --chmod=0644 --checksum=sha256:fa08998aae1e7bdae83bde0712c50e8444d71c0e0c196bb2247ade8d4ad0eb90 \
    https://repo1.maven.org/maven2/net/bytebuddy/byte-buddy/1.15.11/byte-buddy-1.15.11.jar /opt/lp/libs/

# --- Kernel: compile, self-test, and dump a class-data-sharing archive for fast starts ---
FROM libs AS kernel
COPY kernel/src /build/src
RUN chmod 0755 /opt/lp /opt/lp/libs \
 && mkdir -p /build/classes /work \
 && javac --release 21 -Xlint:none -d /build/classes -cp "/opt/lp/libs/*" $(find /build/src -name '*.java') \
 && jar --create --file /opt/lp/kernel.jar -C /build/classes . \
 && java -XX:ArchiveClassesAtExit=/opt/lp/kernel.jsa -Xshare:auto -cp "/opt/lp/kernel.jar:/opt/lp/libs/*" \
         -Dlp.libs=/opt/lp/libs lp.Kernel selftest

# --- Node binary for the runner and the gate ---
FROM node:22-bookworm-slim AS node

# --- Runtime ---
FROM eclipse-temurin:21-jdk-jammy
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=kernel /opt/lp /opt/lp
RUN groupadd --gid 10001 sandbox && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox \
 && mkdir -p /work && chown 10001:10001 /work \
 && node --version
WORKDIR /opt/lp/service
COPY package.json ./
COPY src ./src
ENV NODE_ENV=production
# The gate needs root for the Docker socket; the runner drops to uid 10001 itself, and every
# sandbox container is created with User 10001 by the gate.
CMD ["node", "src/runner.js"]
