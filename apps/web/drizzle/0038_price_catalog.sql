CREATE TABLE `price_offer` (
	`account_id` text NOT NULL,
	`region` text NOT NULL,
	`offer_id` text NOT NULL,
	`name` text NOT NULL,
	`vcpus` integer NOT NULL,
	`memory_mb` integer NOT NULL,
	`disk_gb` integer,
	`arch` text NOT NULL,
	`gpu` text,
	`hourly` real,
	`spot_hourly` real,
	`egress_per_gb` real,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `region`, `offer_id`),
	FOREIGN KEY (`account_id`) REFERENCES `adapter_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `price_region` (
	`account_id` text NOT NULL,
	`region` text NOT NULL,
	`wanted_at` integer NOT NULL,
	`fetched_at` integer,
	`error` text,
	`tried_at` integer,
	PRIMARY KEY(`account_id`, `region`),
	FOREIGN KEY (`account_id`) REFERENCES `adapter_account`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `price_region_tried` ON `price_region` (`tried_at`);