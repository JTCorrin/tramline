CREATE TABLE `access_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`node_id` text,
	`kind` text NOT NULL,
	`host` text,
	`method` text,
	`path` text,
	`status` integer,
	`outcome` text,
	`duration_ms` real NOT NULL,
	`bytes` integer NOT NULL,
	`client` text NOT NULL,
	`asn` integer,
	`network` text,
	`user_agent` text,
	`weight` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `access_log_service` ON `access_log` (`service_id`,`environment_id`,`at`);--> statement-breakpoint
CREATE INDEX `access_log_at` ON `access_log` (`at`);