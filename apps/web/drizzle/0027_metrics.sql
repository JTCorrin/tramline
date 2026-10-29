CREATE TABLE `alert` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`node_id` text,
	`service_id` text,
	`environment_id` text,
	`message` text NOT NULL,
	`opened_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_open` ON `alert` (`resolved_at`,`kind`);--> statement-breakpoint
CREATE TABLE `container_metric` (
	`step` integer NOT NULL,
	`bucket` integer NOT NULL,
	`deployment_id` text NOT NULL,
	`replica` integer NOT NULL,
	`service_id` text NOT NULL,
	`environment_id` text NOT NULL,
	`samples` integer NOT NULL,
	`cpu_sum` real NOT NULL,
	`cpu_max` real NOT NULL,
	`memory_sum` real NOT NULL,
	`memory_max` real NOT NULL,
	`memory_limit` real,
	`rx_bytes` integer NOT NULL,
	`tx_bytes` integer NOT NULL,
	PRIMARY KEY(`step`, `deployment_id`, `replica`, `bucket`),
	FOREIGN KEY (`deployment_id`) REFERENCES `deployment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `service`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `container_metric_service` ON `container_metric` (`service_id`,`environment_id`,`step`,`bucket`);--> statement-breakpoint
CREATE TABLE `node_metric` (
	`step` integer NOT NULL,
	`bucket` integer NOT NULL,
	`node_id` text NOT NULL,
	`samples` integer NOT NULL,
	`cpu_sum` real NOT NULL,
	`cpu_max` real NOT NULL,
	`memory_used_sum` real NOT NULL,
	`memory_used_max` real NOT NULL,
	`memory_total` real NOT NULL,
	`disk_used` real,
	`disk_total` real,
	PRIMARY KEY(`step`, `node_id`, `bucket`),
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
