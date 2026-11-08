# Lambda

Tramline creates nodes as on-demand GPU instances on Lambda Cloud. Each instance boots Lambda's default image, which already has the NVIDIA driver, Docker and the NVIDIA container toolkit, and enrolls itself through cloud-init. Services that ask for GPUs can then run there. Removing the node terminates the instance.

GPU instances are expensive: from about $0.50 to well over $20 an hour, billed while they run. Every size Tramline offers shows Lambda's hourly price, and node pools ask before they can grow. Remove nodes you aren't using.

You need three things: a Lambda Cloud account with a payment method, an API key, and a Tramline URL the instances can reach.

## 1. The account

- **Billing:** Lambda won't launch instances until the account has a valid billing address and payment method.
- **Capacity:** Lambda only has some sizes free in some regions at any moment. Tramline only offers the sizes Lambda says have room in the region you pick, so the list changes. If a launch is refused for lack of capacity, try another size or region, or try again later.
- **Quota:** new accounts may be limited in how many instances they run. Ask Lambda support for more if a launch is refused for quota.

## 2. An API key

1. In the Lambda Cloud dashboard, go to **API keys** and create a key. Name it, e.g. `tramline`.
2. Copy the key. It's shown once.

Enter it under Nodes → Compute accounts → Lambda. Tramline stores it encrypted and never shows it again. The key can launch and terminate instances on the account, so treat it like a password. If your account uses roles, the key needs to manage instances, SSH keys and firewall rules.

## 3. Reaching Tramline

Instances enroll over the internet, so Tramline needs an address they can reach. That can be its own public HTTPS address, or a Cloudflare tunnel set up under Nodes → Public access when Tramline runs at home.

## What Tramline creates

- **Instances** of the size you choose, named after the node, with the tag `tramline=node`.
  - **Image:** Lambda's default, Ubuntu with Lambda Stack (NVIDIA driver, CUDA, Docker and the NVIDIA container toolkit). Cloud-init sees Docker is there and doesn't install it again; it only enrolls the machine.
  - **Arm:** GH200 sizes have an Arm CPU. They're offered as arm64, and the agent runs on them, but check your own images run on Arm before you choose one.
  - **Cloud-init** comes in Lambda's `user_data`, which Lambda's API never returns. It holds the join token, which works once and is spent at boot.
- **SSH key:** Lambda requires one on every instance, so Tramline adds `tramline-no-login` to the account the first time. Its private half is generated and thrown away, so nobody can sign in with it; Tramline never needs SSH. It stays on the account for the next node.
- **Firewall:** Lambda's firewall rules are one list for the whole account, applied to all its instances, and Lambda only lets that list be replaced as a whole. With "Open the mesh port" on, Tramline reads the list, adds one rule allowing UDP 51820 from anywhere if no rule already covers it, and writes the list back with all your rules in it. Nothing else is changed: SSH (TCP 22) and ICMP stay as Lambda and you set them. Turn the option off to leave the firewall alone; the nodes then connect out to the rest of the mesh, which works as long as the node on the other end has its mesh port open.
  - Lambda's docs say firewall rules don't apply in **us-south-1**, so Tramline doesn't change them for nodes there.
- **Mesh:** when the mesh port is open, a node offers its public address as its mesh endpoint, so nodes elsewhere reach it directly. Lambda has no documented metadata server, so the node reads the address from its own network interface, and offers none if that address is private.
- **Edge nodes:** not yet. The firewall applies to every instance on the account, so TCP 80 and 443 can't be opened to one machine only.
- **Safety:** Tramline only lists and terminates instances with its tag, or launched with only its `tramline-no-login` key. Asking it to remove anything else fails with "wasn't created by Tramline". It also won't launch a second instance with the name of one it already runs.
- **JupyterLab:** Lambda runs JupyterLab on its instances, reachable from Lambda's dashboard. That's a shell on the machine for anyone with access to your Lambda account; Tramline doesn't turn it off.

## Conformance against a real account

This launches a real GPU instance, which is billed for as long as the test runs (usually a few minutes; pick a cheap size).

```sh
TRAMLINE_LAMBDA_API_KEY=… TRAMLINE_LAMBDA_REGION=us-east-1 TRAMLINE_LAMBDA_OFFER=gpu_1x_a10 \
  pnpm --filter @tramline/adapter-lambda test
```

It launches the instance, checks that it's listed, terminates it, and checks nothing is left behind. The SSH key and the firewall rule stay, for the next run.
