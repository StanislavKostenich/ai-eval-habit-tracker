properties:
  configuration:
    ingress:
      external: true
      allowInsecure: false
      targetPort: 80
  template:
    containers:
      - name: backend
        image: __BACKEND_IMAGE__
        env:
          - name: NODE_ENV
            value: production
          - name: PORT
            value: "3000"
          - name: DATABASE_PATH
            value: /data/habits.db
          - name: FRONTEND_URL
            value: https://placeholder.azurecontainerapps.io
          - name: BACKEND_URL
            value: https://placeholder.azurecontainerapps.io
        resources:
          cpu: 0.5
          memory: 1Gi
      - name: frontend
        image: __FRONTEND_IMAGE__
        resources:
          cpu: 0.25
          memory: 0.5Gi
    scale:
      minReplicas: 1
      maxReplicas: 3
