CREATE TABLE `node_spend` (
	`day` text NOT NULL,
	`node_id` text NOT NULL,
	`node_name` text NOT NULL,
	`amount` real NOT NULL,
	PRIMARY KEY(`day`, `node_id`)
);
--> statement-breakpoint
CREATE TABLE `service_spend` (
	`day` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`amount` real NOT NULL,
	PRIMARY KEY(`day`, `service_id`, `environment_id`),
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `service_spend_environment` ON `service_spend` (`environment_id`,`day`);