resource "aws_ecr_repository" "app" {
  name                 = var.repository_name
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }

  tags = {
    Project = var.name_prefix
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images older than 7 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 7
        }
        action = {
          type = "expire"
        }
      },
      {
        rulePriority = 2
        description  = "Retain the newest 10 git-tagged application images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["git-"]
          countType     = "imageCountMoreThan"
          countNumber   = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

variable "name_prefix" {
  description = "Existing project/environment prefix used for tags."
  type        = string
}

variable "repository_name" {
  description = "Private ECR repository name for the application image."
  type        = string
}

output "repository_name" {
  description = "Name of the private ECR repository."
  value       = aws_ecr_repository.app.name
}

output "repository_url" {
  description = "Repository URL used to tag images before pushing to ECR."
  value       = aws_ecr_repository.app.repository_url
}

output "repository_arn" {
  description = "ARN of the private ECR repository."
  value       = aws_ecr_repository.app.arn
}
