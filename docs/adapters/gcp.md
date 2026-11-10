# Google Cloud

Tramline creates nodes as Compute Engine VMs. Each VM boots Ubuntu, installs Docker, and enrolls itself through cloud-init. Removing the node deletes the VM and its disk.

You need three things: a project with the Compute Engine API on (and the Cloud Billing API, for prices), a service account key, and a Tramline URL the VMs can reach.

## 1. The project

- **Billing:** the project needs a billing account, even for the free tier. An `e2-micro` in `us-central1`, `us-east1` or `us-west1` is free for one VM a month.
- **The APIs:** turn on the Compute Engine API (`compute.googleapis.com`) under APIs & Services → Library. A project that has never used it says so when you test the account.
- **Prices:** also turn on the Cloud Billing API (`cloudbilling.googleapis.com`). Tramline reads each size's hourly price from Google's public price catalog through it, which needs no extra role. Without it, sizes still list and machines still work, but their prices show as unknown. Tramline checks again every 10 minutes, so turning it on later is enough.

## 2. A service account key

1. Under IAM & Admin → Service Accounts, create an account, e.g. `tramline`.
2. Give it these roles on the project:
   - **Compute Instance Admin (v1)** to create, read and delete VMs, and to tag edge nodes (`compute.instances.setTags`).
   - **Compute Security Admin** to add the firewall rules for the mesh and for edge nodes. Without it, turn off "Open the mesh port" and allow UDP 51820 to VMs tagged `tramline` yourself, and allow TCP 80 and 443 to VMs tagged `tramline-edge` if you'll have edge nodes.
3. Open the account → Keys → Add key → Create new key → JSON. The file downloads once.

Paste the file's contents into Nodes → Compute accounts → Google Cloud, or load the file there. Tramline stores it encrypted and never shows it again, so delete the download afterwards.

If key creation is blocked, your organization enforces `iam.disableServiceAccountKeyCreation`. An organization admin can lift it for this project.

## 3. Reaching Tramline

VMs enroll over the internet, so Tramline needs an address they can reach. That can be its own public HTTPS address, or a Cloudflare tunnel set up under Nodes → Public access when Tramline runs at home.

## What Tramline creates

- **VMs** named after the node, with the label `tramline=node` and the network tag `tramline`. They have a public address and **no service account**, so a compromised node has no Google Cloud access.
- **Placement:** you choose a region, and Tramline uses its first zone that has the size and room for it, trying the next one when a zone is out of capacity.
- **Firewall:** one rule per network, `tramline-mesh-<network>`, allowing UDP 51820 to the `tramline` tag. Nodes offer their public address as their mesh endpoint, so nodes elsewhere reach them directly.
- **Edge nodes:** turning on a node's Edge switch adds the network tag `tramline-edge` to its VM, and creates one rule per network the first time, `tramline-edge-<network>`, allowing TCP 80 and 443 from anywhere to that tag and nothing else. Turning it off removes the tag; the rule stays and matches nothing. Caddy on the node only answers for hostnames with a public domain, and services never get host ports, so the rest of the node stays private. SSH stays closed.
- **Prices:** list prices in USD, from the Compute Engine part of the Cloud Billing catalog, read once a day for every region: each size's vCPUs at its family's core rate plus its memory at the family's RAM rate (a shared-core `e2-micro`, `e2-small` or `e2-medium` counts as 0.25, 0.5 or 1 vCPU). Committed-use, custom and sole-tenant rates aren't used, and a size whose rates aren't in the catalog shows no price rather than a guess. Egress is Premium Tier's first internet tier, $0.12 per GB. Spot VMs aren't offered, so there's no spot price.
- **Safety:** Tramline only lists, deletes and tags VMs with its label, so a key with wider permissions still can't touch your other VMs.

## Conformance against a real project

```sh
TRAMLINE_GCP_KEY_FILE=key.json TRAMLINE_GCP_REGION=us-central1 \
  pnpm --filter @tramline/adapter-gcp test
```

It creates an `e2-micro`, checks that it's listed, opens and closes its edge ports, deletes it, and checks nothing is left behind. The firewall rules stay, for the next run.
