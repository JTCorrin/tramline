CREATE TABLE `drill` (
	`id` text PRIMARY KEY NOT NULL,
	`backup_id` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`error` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`backup_id`) REFERENCES `backup`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drill_backup_idx` ON `drill` (`backup_id`);