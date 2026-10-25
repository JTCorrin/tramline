CREATE TABLE `join_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`cordoned` integer DEFAULT false NOT NULL,
	`created_by` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`node_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_token_token_hash_unique` ON `join_token` (`token_hash`);--> statement-breakpoint
ALTER TABLE `node` ADD `cordoned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `node` ADD `draining` integer DEFAULT false NOT NULL;