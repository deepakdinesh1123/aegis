resource "aws_secretsmanager_secret" "github" {
  name                    = "${local.name_prefix}/github"
  description             = "GitHub App credentials for Aegis"
  recovery_window_in_days = 0

  tags = {
    Name = "${local.name_prefix}-github"
  }
}

resource "aws_secretsmanager_secret_version" "github" {
  secret_id = aws_secretsmanager_secret.github.id

  secret_string = jsonencode({
    APP_ID         = var.github_app_id
    PRIVATE_KEY    = var.github_app_private_key
    WEBHOOK_SECRET = var.github_webhook_secret
  })
}

