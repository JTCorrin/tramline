CREATE TABLE `ssh_failure` (
	`node_id` text NOT NULL,
	`bucket` integer NOT NULL,
	`client` text NOT NULL,
	`count` integer NOT NULL,
	`user` text,
	`asn` integer,
	`network` text,
	PRIMARY KEY(`node_id`, `bucket`, `client`),
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ssh_failure_bucket` ON `ssh_failure` (`bucket`);--> statement-breakpoint
ALTER TABLE `node` ADD `ssh_watch` text;