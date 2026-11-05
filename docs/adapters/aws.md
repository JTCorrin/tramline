# Amazon Web Services

Tramline creates nodes as EC2 instances. Each instance boots Ubuntu, installs Docker, and enrolls itself through cloud-init. Removing the node terminates the instance, which deletes its disk.

You need three things: an account, an IAM user's access key with the policy below, and a Tramline URL the instances can reach.

## 1. The account

- **Free tier:** `t3.micro` is free-tier eligible.
- **Default VPC:** Tramline uses each region's default VPC. Accounts have one unless it was deleted; recreate it under VPC → Your VPCs → Actions → Create default VPC.
- **Regions:** only the regions enabled for the account are offered. Enable more under Account → AWS Regions.
- **Quota:** new accounts have a small vCPU quota per region. Request more under Service Quotas → Amazon EC2 if a size is refused.

## 2. An access key

1. Under IAM → Policies, create a policy from this JSON, e.g. `tramline-nodes`:

   ```json
   {
   	"Version": "2012-10-17",
   	"Statement": [
   		{
   			"Sid": "Read",
   			"Effect": "Allow",
   			"Action": [
   				"ec2:DescribeRegions",
   				"ec2:DescribeInstances",
   				"ec2:DescribeInstanceTypes",
   				"ec2:DescribeImages",
   				"ec2:DescribeVpcs",
   				"ec2:DescribeSubnets",
   				"ec2:DescribeSecurityGroups"
   			],
   			"Resource": "*"
   		},
   		{
   			"Sid": "RunOnlyTagged",
   			"Effect": "Allow",
   			"Action": "ec2:RunInstances",
   			"Resource": ["arn:aws:ec2:*:*:instance/*", "arn:aws:ec2:*:*:volume/*"],
   			"Condition": { "StringEquals": { "aws:RequestTag/tramline": "node" } }
   		},
   		{
   			"Sid": "RunWith",
   			"Effect": "Allow",
   			"Action": "ec2:RunInstances",
   			"Resource": [
   				"arn:aws:ec2:*::image/*",
   				"arn:aws:ec2:*:*:subnet/*",
   				"arn:aws:ec2:*:*:network-interface/*",
   				"arn:aws:ec2:*:*:security-group/*"
   			]
   		},
   		{
   			"Sid": "TagWhenCreating",
   			"Effect": "Allow",
   			"Action": "ec2:CreateTags",
   			"Resource": "*",
   			"Condition": {
   				"StringEquals": { "ec2:CreateAction": ["RunInstances", "CreateSecurityGroup"] }
   			}
   		},
   		{
   			"Sid": "TerminateOnlyTagged",
   			"Effect": "Allow",
   			"Action": "ec2:TerminateInstances",
   			"Resource": "arn:aws:ec2:*:*:instance/*",
   			"Condition": { "StringEquals": { "aws:ResourceTag/tramline": "node" } }
   		},
   		{
   			"Sid": "Ports",
   			"Effect": "Allow",
   			"Action": ["ec2:CreateSecurityGroup", "ec2:AuthorizeSecurityGroupIngress"],
   			"Resource": "*"
   		},
   		{
   			"Sid": "EdgeOnlyTagged",
   			"Effect": "Allow",
   			"Action": "ec2:ModifyInstanceAttribute",
   			"Resource": "arn:aws:ec2:*:*:instance/*",
   			"Condition": { "StringEquals": { "aws:ResourceTag/tramline": "node" } }
   		},
   		{
   			"Sid": "EdgeGroups",
   			"Effect": "Allow",
   			"Action": "ec2:ModifyInstanceAttribute",
   			"Resource": "arn:aws:ec2:*:*:security-group/*"
   		}
   	]
   }
   ```

   The conditions mean the key can only start instances tagged `tramline=node`, and only terminate those, so it can't touch your other instances even if it leaks. `Ports` creates the security groups below and their rules; leave it out and turn off "Open the mesh port" if you manage the security groups yourself. `EdgeOnlyTagged` and `EdgeGroups` let the Edge switch change the security groups of instances tagged `tramline=node`, and no others; leave them out if no node of this account will be an edge node.

2. Under IAM → Users, create a user, e.g. `tramline`, with no console access, and attach the policy.
3. Open the user → Security credentials → Create access key → "Application running outside AWS". Copy both the access key ID and the secret; the secret is shown once.

Enter them under Nodes → Compute accounts → Amazon Web Services. Tramline stores the secret encrypted and never shows it again.

## 3. Reaching Tramline

Instances enroll over the internet, so Tramline needs an address they can reach. That can be its own public HTTPS address, or a Cloudflare tunnel set up under Nodes → Public access when Tramline runs at home.

## What Tramline creates

- **Instances** from Canonical's latest Ubuntu 24.04 AMI, tagged `tramline=node` with the node's name as `Name`. Their volumes are tagged the same way.
  - A public address, and an encrypted gp3 root disk that's deleted with the instance.
  - **No IAM role and no key pair:** a compromised node has no AWS access, and nobody can SSH in. Tramline never needs SSH.
  - **IMDSv2 only, one hop:** the metadata service answers the host but not containers on Docker's bridge network, so a workload can't read the instance's user data (which holds the join token) or anything else about the machine.
- **Placement:** you choose a region, and Tramline uses its first availability zone with room, trying the next when one is out of capacity.
- **Security group:** `tramline-mesh` in each region's default VPC, allowing UDP 51820 from anywhere and nothing else inbound. Nodes offer their public address as their mesh endpoint, so nodes elsewhere reach them directly.
- **Edge nodes:** turning on a node's Edge switch adds its instance to the security group `tramline-edge` (created in the default VPC the first time), which allows TCP 80 and 443 from anywhere (IPv4 and IPv6) and nothing else. Turning it off removes the instance from the group again; the instance's other groups, `tramline-mesh` included, stay. Caddy on the node only answers for hostnames with a public domain, and services never get host ports, so the rest of the node stays private. SSH stays closed.
- **Safety:** Tramline only lists, terminates and changes the security groups of instances with its tag.

## Conformance against a real account

```sh
TRAMLINE_AWS_KEY_ID=AKIA… TRAMLINE_AWS_SECRET=… TRAMLINE_AWS_REGION=us-east-1 \
  pnpm --filter @tramline/adapter-aws test
```

It starts a `t3.micro`, checks that it's listed, opens and closes its edge ports, terminates it, and checks nothing is left behind. The security groups stay, for the next run.
