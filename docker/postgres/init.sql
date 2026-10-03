-- Runs once, when the Postgres container first creates its data directory.
-- Development passwords only; set real ones through secrets in production.

CREATE ROLE somiti_owner LOGIN PASSWORD 'somiti_owner_dev';
CREATE ROLE somiti_app LOGIN PASSWORD 'somiti_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

CREATE DATABASE somiti OWNER somiti_owner;
\connect somiti
ALTER SCHEMA public OWNER TO somiti_owner;
