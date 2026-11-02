CREATE TABLE `public_tunnel` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`hostname` text NOT NULL,
	`api_token` text NOT NULL,
	`account_id` text NOT NULL,
	`zone_id` text NOT NULL,
	`zone_name` text NOT NULL,
	`tunnel_id` text NOT NULL,
	`dns_record_id` text NOT NULL,
	`tunnel_token` text NOT NULL,
	`origin_url` text NOT NULL,
	`node_id` text,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
