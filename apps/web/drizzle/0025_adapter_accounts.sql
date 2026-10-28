CREATE TABLE `adapter_account` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter` text NOT NULL,
	`name` text NOT NULL,
	`credentials` text NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adapter_account_name_unique` ON `adapter_account` (`name`);--> statement-breakpoint
ALTER TABLE `join_token` ADD `adapter_account_id` text REFERENCES adapter_account(id);--> statement-breakpoint
ALTER TABLE `join_token` ADD `provider_node_id` text;--> statement-breakpoint
ALTER TABLE `join_token` ADD `region` text;--> statement-breakpoint
ALTER TABLE `join_token` ADD `offer` text;--> statement-breakpoint
ALTER TABLE `node` ADD `adapter_account_id` text REFERENCES adapter_account(id);--> statement-breakpoint
ALTER TABLE `node` ADD `provider_node_id` text;