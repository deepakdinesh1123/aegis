variable "aws_region" {
  type        = string
  description = "AWS region for all resources."
  default     = "us-east-1"
}

variable "environment" {
  type        = string
  description = "Environment name (used in resource names/tags)."
  default     = "prod"
}

variable "project_name" {
  type        = string
  description = "Short project prefix for resource names."
  default     = "aegis"
}

variable "github_app_id" {
  type        = string
  description = "GitHub App ID."
  sensitive   = true
}

variable "github_app_private_key" {
  type        = string
  description = "GitHub App private key PEM (including BEGIN/END lines)."
  sensitive   = true
}

variable "github_webhook_secret" {
  type        = string
  description = "GitHub App webhook secret used to verify signatures."
  sensitive   = true
}

variable "dynamodb_table_name" {
  type        = string
  description = "DynamoDB table name for pull-request state."
  default     = "pull-request-state"
}

variable "lambda_memory_mb" {
  type        = number
  description = "Memory for both Lambdas (MB)."
  default     = 512
}

variable "webhook_timeout_seconds" {
  type        = number
  description = "Webhook Lambda timeout (enqueue-only; keep low)."
  default     = 15
}

variable "worker_timeout_seconds" {
  type        = number
  description = "Worker Lambda timeout (mergeability retries + GitHub API)."
  default     = 120
}

variable "worker_reserved_concurrency" {
  type        = number
  description = "Optional reserved concurrency for the worker. null = account default scaling."
  default     = null
  nullable    = true
}

variable "sqs_visibility_timeout_seconds" {
  type        = number
  description = "Must be >= worker_timeout_seconds."
  default     = 150

  validation {
    condition     = var.sqs_visibility_timeout_seconds >= var.worker_timeout_seconds
    error_message = "sqs_visibility_timeout_seconds must be >= worker_timeout_seconds."
  }
}

variable "sqs_max_receive_count" {
  type        = number
  description = "Receives before a message is sent to the DLQ."
  default     = 5
}

variable "sqs_batch_size" {
  type        = number
  description = "SQS → Lambda batch size."
  default     = 5
}

variable "max_mergeability_queue_attempts" {
  type        = number
  description = "Max deferred RetryMergeability attempts."
  default     = 5
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log retention for Lambdas."
  default     = 14
}
