CREATE TABLE `cron_run` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`error` text,
	`scheduled_for` integer NOT NULL,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cron_run_deployment_idx` ON `cron_run` (`deployment_id`);