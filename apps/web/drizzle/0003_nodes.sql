CREATE TABLE `container` (
	`name` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`replica` integer NOT NULL,
	`state` text NOT NULL,
	`healthy` integer,
	`exit_code` integer,
	`restart_count` integer DEFAULT 0 NOT NULL,
	`error` text,
	`started_at` integer,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `container_deployment_idx` ON `container` (`deployment_id`);--> statement-breakpoint
CREATE TABLE `node` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter` text DEFAULT 'manual' NOT NULL,
	`token_hash` text NOT NULL,
	`info` text,
	`error` text,
	`last_seen_at` integer,
	`revision` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_name_unique` ON `node` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `node_token_hash_unique` ON `node` (`token_hash`);--> statement-breakpoint
ALTER TABLE `deployment` ADD `node_id` text REFERENCES node(id);--> statement-breakpoint
ALTER TABLE `deployment` ADD `message` text;--> statement-breakpoint
ALTER TABLE `service_instance` ADD `domain` text;--> statement-breakpoint
CREATE UNIQUE INDEX `service_instance_domain_unique` ON `service_instance` (`domain`);