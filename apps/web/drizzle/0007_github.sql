CREATE TABLE `github_app` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`html_url` text NOT NULL,
	`owner` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`private_key` text NOT NULL,
	`webhook_secret` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_installation` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`account` text NOT NULL,
	`account_type` text NOT NULL,
	`html_url` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
