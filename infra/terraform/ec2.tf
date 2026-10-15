# La instancia. Una sola, con docker compose adentro: es la forma de deploy acordada
# para este proyecto. Todo el estado que importa vive en el volumen de Postgres.

data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-6.1-x86_64"
}

resource "aws_instance" "app" {
  ami                    = data.aws_ssm_parameter.al2023.value
  instance_type          = var.instance_type
  subnet_id              = local.subnet_id
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  key_name               = var.ssh_key_name

  user_data                   = file("${path.module}/user-data.sh")
  user_data_replace_on_change = false

  # IMDSv2 obligatorio. El instance role es el único mecanismo de credenciales del
  # deploy, así que dejar IMDSv1 abierto es dejar abierta la puerta a que un SSRF
  # en el proceso se lleve las credenciales que leen Secrets Manager.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2 # los contenedores hacen un hop extra
  }

  root_block_device {
    volume_size           = var.root_volume_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = false # el volumen de Postgres vive acá
  }

  lifecycle {
    # El AMI sale de un parámetro SSM que Amazon mueve solo: sin esto, el parche de
    # rutina de upstream hace que el próximo plan proponga destruir y recrear la
    # instancia. Reemplazarla es una decisión explícita (taint), no un efecto
    # secundario de correr plan un martes.
    ignore_changes = [ami, user_data]
  }

  tags = {
    Name = local.name
  }
}
