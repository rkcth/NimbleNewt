# Example configuration profiles

Illustrative only. Nothing here is a working installation, and nothing here activates a paid service.

- `public.example.json`: what a shared profile looks like. Environment-specific values are `{{placeholders}}` to be filled in on import, the only enabled provider is the credential-free `fake` adapter, the cloud provider is present but **disabled**, there are no grants, isolation is strong, and remote exposure is off.
- `private.example.json`: what one installation's own profile may add: real paths, a PostgreSQL controller (the connection string is a secret **reference**, not a value), an enabled paid provider, a private approval grant, trusted-host execution with a named authorizer, and remote exposure. A private profile is never shared; `exportProfile` strips all of this when producing a shareable one.

Secrets are never written in a configuration. A setting that needs one holds `{ "secret": "name" }`, and the value comes from the secret store (environment variable `NIMBLENEWT_SECRET_<NAME>`, a file in a secrets directory, or memory in tests). The `.invalid` hostnames are reserved and never resolve.
