locals {
  lambda_src_hash = sha256(join("", concat(
    [for f in sort(fileset("${path.module}/../src", "**/*.ts")) : filesha256("${path.module}/../src/${f}")],
    [
      filesha256("${path.module}/../package-lock.json"),
      filesha256("${path.module}/../scripts/package-lambdas.sh"),
    ]
  )))
}

resource "terraform_data" "lambda_bundle" {
  triggers_replace = [local.lambda_src_hash]

  provisioner "local-exec" {
    command     = "bash '${path.module}/../scripts/package-lambdas.sh'"
    working_dir = path.module
  }
}

resource "aws_cloudwatch_log_group" "webhook" {
  name              = "/aws/lambda/${local.name_prefix}-webhook"
  retention_in_days = var.log_retention_days
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${local.name_prefix}-worker"
  retention_in_days = var.log_retention_days
}

locals {
  github_secret = jsondecode(aws_secretsmanager_secret_version.github.secret_string)
}

resource "aws_lambda_function" "webhook" {
  function_name = "${local.name_prefix}-webhook"
  role          = aws_iam_role.webhook.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["x86_64"]

  filename         = "${path.module}/../dist/lambda/webhook.zip"
  source_code_hash = try(filebase64sha256("${path.module}/../dist/lambda/webhook.zip"), local.lambda_src_hash)

  memory_size = var.lambda_memory_mb
  timeout     = var.webhook_timeout_seconds

  environment {
    variables = merge(local.common_env, {
      WEBHOOK_SECRET = local.github_secret["WEBHOOK_SECRET"]
    })
  }

  depends_on = [
    terraform_data.lambda_bundle,
    aws_cloudwatch_log_group.webhook,
    aws_iam_role_policy.webhook,
  ]
}

resource "aws_lambda_function" "worker" {
  function_name = "${local.name_prefix}-worker"
  role          = aws_iam_role.worker.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  architectures = ["x86_64"]

  filename         = "${path.module}/../dist/lambda/worker.zip"
  source_code_hash = try(filebase64sha256("${path.module}/../dist/lambda/worker.zip"), local.lambda_src_hash)

  memory_size = var.lambda_memory_mb
  timeout     = var.worker_timeout_seconds

  reserved_concurrent_executions = var.worker_reserved_concurrency

  environment {
    variables = merge(local.common_env, {
      APP_ID      = local.github_secret["APP_ID"]
      PRIVATE_KEY = local.github_secret["PRIVATE_KEY"]
    })
  }

  depends_on = [
    terraform_data.lambda_bundle,
    aws_cloudwatch_log_group.worker,
    aws_iam_role_policy.worker,
  ]
}

resource "aws_lambda_event_source_mapping" "worker_sqs" {
  event_source_arn                   = aws_sqs_queue.events.arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = var.sqs_batch_size
  maximum_batching_window_in_seconds = 2
  enabled                            = true
  function_response_types            = ["ReportBatchItemFailures"]
}

resource "aws_lambda_permission" "apigw_webhook" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.webhook.execution_arn}/*/*"
}
