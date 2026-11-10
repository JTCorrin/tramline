# Hetzner Cloud

Tramline creates nodes as Hetzner Cloud servers. Each server boots Ubuntu, installs Docker, and enrolls itself through cloud-init. Removing the node deletes the server and its public address.

You need two things: a project API token with Read & Write, and a Tramline URL the servers can reach.

## 1. A project and a token

1. In the [Hetzner Console](https://console.hetzner.com/), create a project, e.g. `tramline`, or use one you have. Tramline only touches servers it labelled, but a project of its own keeps things tidy.
2. In the project, go to Security → API tokens → Generate API token. Choose **Read & Write**; a read-only token can't create servers. Copy the token: it is shown once.

Enter it under Nodes → Compute accounts → Hetzner Cloud. Tramline stores it encrypted and never shows it again. Testing the account checks the token with a read; whether it can write only shows when the first server is created, so pick Read & Write.

- **Limits:** new accounts can only run a few servers at once. Hetzner raises the limit on request.
- **Prices:** offers show Hetzner's hourly price without VAT, converted from your account's currency (usually euros) to US dollars at the European Central Bank's daily reference rate, so they compare with other providers'. Hetzner bills you in your own currency, so what you pay moves with the rate. The rates are kept for a day; if they can't be fetched (`www.ecb.europa.eu`), sizes are still offered, without prices.

## 2. Reaching Tramline

Servers enroll over the internet, so Tramline needs an address they can reach. That can be its own public HTTPS address, or a Cloudflare tunnel set up under Nodes → Public access when Tramline runs at home.

## What Tramline creates

- **Per node:** a server named after the node, and a Primary IPv4 `<name>-ipv4` that is made first. Both carry the label `tramline=node`.
  - The server runs Ubuntu 24.04, the x86 or Arm build to match the size. Sizes are the location's current types up to 16 vCPUs, shared and dedicated, x86 and Arm (`cax`). The disk is the size's own.
  - It has no root password. Its SSH key, `tramline-no-login`, is generated once per project and its private half thrown away, so nobody can sign in; Tramline never needs SSH.
  - It gets no IPv6 address; the mesh and public domains use IPv4.
  - The address is set to be deleted with the server, so removing the node leaves nothing billed.
- **Mesh:** the firewall `tramline-mesh` (made once per project) is applied to every node. It lets in UDP 51820 from anywhere and nothing else, so SSH is closed too. A node's address is known before it boots, and it offers that as its mesh endpoint, so nodes elsewhere reach it directly. Rules you add to the firewall stay.
- **Edge nodes:** turning on a node's Edge switch applies a second firewall, `tramline-edge` (made the first time), to that server only. It lets in TCP 80 and 443 from anywhere; Hetzner combines the rules of every firewall on a server. Turning it off removes the firewall from the server; the firewall stays. Caddy on the node only answers for hostnames with a public domain, and services never get host ports, so the rest of the node stays private.
- **Safety:** Tramline only lists, deletes and changes servers with its label, so a token for a shared project still can't delete your other servers. It won't use a firewall or SSH key with its names unless it made them. A create that fails removes what it made.

## Conformance against a real project

```sh
TRAMLINE_HETZNER_TOKEN=… TRAMLINE_HETZNER_REGION=fsn1 TRAMLINE_HETZNER_OFFER=cx23 \
  pnpm --filter @tramline/adapter-hetzner test
```

It creates a server of that size, checks that it's listed, opens and closes its edge ports, deletes it, and checks nothing is left behind. The firewalls and the SSH key stay, for the next run.
