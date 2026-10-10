FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential qtbase5-dev qttools5-dev-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
ARG JAMULUS_BUILD_JOBS=2
RUN curl -fL --retry 3 https://codeload.github.com/jamulussoftware/jamulus/tar.gz/refs/tags/r3_12_5 -o source.tar.gz \
    && echo '623782a9b816fdacdf233db43476c3e1d0ec066639d8d9389108ad8c230dde7f  source.tar.gz' | sha256sum -c - \
    && tar -xzf source.tar.gz --strip-components=1 \
    && qmake 'CONFIG+=headless serveronly nojsonrpc disable_version_check' \
    && nice -n 19 make -j"${JAMULUS_BUILD_JOBS}"

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libqt5core5a libqt5network5 libqt5concurrent5 libqt5xml5 python3-minimal \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home musician
COPY --from=build /src/Jamulus /usr/local/bin/jamulus
COPY --from=build /src/COPYING /src/source.tar.gz /usr/share/doc/jamulus/
COPY health.py /usr/local/bin/jamulus-health
USER musician
EXPOSE 22124/udp
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 CMD ["python3", "/usr/local/bin/jamulus-health"]
ENTRYPOINT ["/usr/local/bin/jamulus"]
CMD ["--server", "--nogui", "--port", "22124", "--numchannels", "8", "--fastupdate", "--norecord", "--welcomemessage", "Psalmony pilot: 8 musicians. Recording is off. Audio access is independent of Psalmony accounts. Source: https://github.com/jamulussoftware/jamulus/tree/r3_12_5"]
