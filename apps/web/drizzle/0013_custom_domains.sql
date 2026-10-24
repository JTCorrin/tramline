CREATE TABLE `custom_domain` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`hostname` text NOT NULL,
	`token` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`checked_at` integer,
	`verified_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_domain_hostname_unique` ON `custom_domain` (`hostname`);