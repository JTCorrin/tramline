CREATE TABLE `node_pool` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`adapter_account_id` text NOT NULL,
	`region` text NOT NULL,
	`offer` text NOT NULL,
	`offer_name` text NOT NULL,
	`vcpus` integer NOT NULL,
	`memory_mb` integer NOT NULL,
	`hourly` real,
	`for_environment` integer DEFAULT false NOT NULL,
	`environment_id` text,
	`min_nodes` integer DEFAULT 0 NOT NULL,
	`max_nodes` integer NOT NULL,
	`idle_minutes` integer DEFAULT 15 NOT NULL,
	`monthly_cap` real,
	`origin` text NOT NULL,
	`removing` integer DEFAULT false NOT NULL,
	`error` text,
	`error_at` integer,
	`activity` text,
	`activity_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`adapter_account_id`) REFERENCES `adapter_account`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `node_pool_name_unique` ON `node_pool` (`name`);--> statement-breakpoint
ALTER TABLE `join_token` ADD `pool_id` text REFERENCES node_pool(id);--> statement-breakpoint
ALTER TABLE `node` ADD `pool_id` text REFERENCES node_pool(id);--> statement-breakpoint
ALTER TABLE `node` ADD `idle_since` integer;