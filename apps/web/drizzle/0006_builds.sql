CREATE TABLE `build` (
	`deployment_id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`state` text NOT NULL,
	`image` text,
	`commit` text,
	`error` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `deployment` ADD `image` text;--> statement-breakpoint
ALTER TABLE `deployment` ADD `resolved_image` text;--> statement-breakpoint
ALTER TABLE `deployment` ADD `commit` text;--> statement-breakpoint
ALTER TABLE `container` ADD `image_digest` text;