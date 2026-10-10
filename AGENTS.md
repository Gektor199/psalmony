# Psalmony project rules

- Use PostgreSQL as the only server database. This is an explicit user requirement, including their other projects. Do not introduce SQLite or another server database.
- Use Docker Compose for the server and PostgreSQL. Keep persistent database and attachment volumes separate.
- Preserve user content and existing volumes. Never use `docker compose down -v` as a routine restart.
- The client is a cross-platform PWA. Do not describe it as a signed native application or a store release.
- Verify server persistence, access boundaries and optimistic concurrency when changing synchronization.
- Follow Apple HIG principles while preserving Psalmony's own name and artwork. Do not use Apple's logo or imply affiliation.
- Demo lyrics and artwork are original project samples.
- Keep credentials out of version control. Local Compose defaults are for loopback development only.
