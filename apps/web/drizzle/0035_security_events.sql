CREATE TABLE `security_event` (
	`deployment_id` text NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`node_id` text,
	`kind` text NOT NULL,
	`bucket` integer NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`deployment_id`, `kind`, `bucket`),
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `security_event_service` ON `security_event` (`service_id`,`environment_id`,`bucket`);