#!/usr/bin/env bun

import { serve } from "bun";
import { randomBytes } from "node:crypto";

interface AdvancedWidget {
  id: string;
  type: 'metric' | 'chart' | 'alert' | 'custom';
  title: string;
  config: Record<string, any>;
  position: { x: number; y: number; width: number; height: number };
}

interface AnomalyDetection {
  service: string;
  metric: string;
  baseline: number;
  threshold: number;
  detected: boolean;
  timestamp: number;
}

interface AlertCorrelation {
  id: string;
  alerts: Array<{
    service: string;
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    timestamp: number;
  }>;
  correlation: number;
  rootCause?: string;
}

class AdvancedMonitoring {
  private widgets: Map<string, AdvancedWidget> = new Map();
  private anomalies: Map<string, AnomalyDetection> = new Map();
  private correlations: Map<string, AlertCorrelation> = new Map();
  private baselines: Map<string, number> = new Map();
  
  constructor() {
    this.initializeDefaultWidgets();
  }
  
  private initializeDefaultWidgets(): void {
    // CPU Usage Widget
    this.widgets.set('cpu-usage', {
      id: 'cpu-usage',
      type: 'metric',
      title: 'CPU Usage',
      config: {
        metric: 'cpu',
        unit: '%',
        threshold: 80,
        refreshInterval: 5000
      },
      position: { x: 0, y: 0, width: 300, height: 200 }
    });
    
    // Memory Usage Widget
    this.widgets.set('memory-usage', {
      id: 'memory-usage',
      type: 'metric',
      title: 'Memory Usage',
      config: {
        metric: 'memory',
        unit: 'MB',
        threshold: 90,
        refreshInterval: 5000
      },
      position: { x: 320, y: 0, width: 300, height: 200 }
    });
    
    // Service Health Chart
    this.widgets.set('service-health', {
      id: 'service-health',
      type: 'chart',
      title: 'Service Health',
      config: {
        chartType: 'line',
        timeRange: '1h',
        metrics: ['cpu', 'memory', 'response_time'],
        refreshInterval: 10000
      },
      position: { x: 0, y: 220, width: 620, height: 300 }
    });
    
    // Alert Status Widget
    this.widgets.set('alert-status', {
      id: 'alert-status',
      type: 'alert',
      title: 'Active Alerts',
      config: {
        severity: ['high', 'critical'],
        refreshInterval: 3000
      },
      position: { x: 640, y: 0, width: 300, height: 200 }
    });
  }
  
  addWidget(widget: AdvancedWidget): void {
    this.widgets.set(widget.id, widget);
  }
  
  removeWidget(widgetId: string): void {
    this.widgets.delete(widgetId);
  }
  
  updateWidget(widgetId: string, updates: Partial<AdvancedWidget>): void {
    const widget = this.widgets.get(widgetId);
    if (widget) {
      Object.assign(widget, updates);
    }
  }
  
  getWidgets(): AdvancedWidget[] {
    return Array.from(this.widgets.values());
  }
  
  async detectAnomalies(serviceMetrics: Record<string, any>): Promise<AnomalyDetection[]> {
    const anomalies: AnomalyDetection[] = [];
    
    for (const [serviceName, metrics] of Object.entries(serviceMetrics)) {
      for (const [metricName, value] of Object.entries(metrics)) {
        const key = `${serviceName}-${metricName}`;
        const baseline = this.baselines.get(key) || 0;
        
        // Simple anomaly detection using statistical deviation
        const deviation = Math.abs((value as number) - baseline) / baseline;
        const threshold = 0.3; // 30% deviation threshold
        
        if (deviation > threshold) {
          const anomaly: AnomalyDetection = {
            service: serviceName,
            metric: metricName,
            baseline,
            threshold: baseline * (1 + threshold),
            detected: true,
            timestamp: Date.now()
          };
          
          anomalies.push(anomaly);
          this.anomalies.set(key, anomaly);
        }
      }
    }
    
    return anomalies;
  }
  
  async correlateAlerts(alerts: Array<any>): Promise<AlertCorrelation[]> {
    const correlations: AlertCorrelation[] = [];
    
    // Simple correlation based on time proximity and service relationships
    for (let i = 0; i < alerts.length; i++) {
      for (let j = i + 1; j < alerts.length; j++) {
        const alert1 = alerts[i];
        const alert2 = alerts[j];
        
        const timeDiff = Math.abs(alert1.timestamp - alert2.timestamp);
        const timeThreshold = 60000; // 1 minute
        
        if (timeDiff < timeThreshold) {
          const correlation: AlertCorrelation = {
            id: randomBytes(8).toString('hex'),
            alerts: [alert1, alert2],
            correlation: 1 - (timeDiff / timeThreshold)
          };
          
          correlations.push(correlation);
          this.correlations.set(correlation.id, correlation);
        }
      }
    }
    
    return correlations;
  }
  
  updateBaseline(service: string, metric: string, value: number): void {
    const key = `${service}-${metric}`;
    const currentBaseline = this.baselines.get(key) || 0;
    
    // Exponential moving average for baseline
    const alpha = 0.1;
    const newBaseline = alpha * (value as number) + (1 - alpha) * currentBaseline;
    
    this.baselines.set(key, newBaseline);
  }
  
  getAnomalies(): AnomalyDetection[] {
    return Array.from(this.anomalies.values());
  }
  
  getCorrelations(): AlertCorrelation[] {
    return Array.from(this.correlations.values());
  }
  
  generateDashboard(): string {
    const widgets = this.getWidgets();
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BS9 Advanced Monitoring Dashboard</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; max-width: 1400px; margin: 0 auto; }
        .widget { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        .widget-header { font-size: 18px; font-weight: 600; margin-bottom: 15px; color: #333; }
        .widget-content { min-height: 150px; }
        .metric-value { font-size: 36px; font-weight: bold; color: #007bff; }
        .metric-unit { font-size: 14px; color: #666; margin-left: 5px; }
        .alert-item { padding: 10px; margin: 5px 0; border-left: 4px solid #dc3545; background: #f8d7da; }
        .anomaly-item { padding: 10px; margin: 5px 0; border-left: 4px solid #ffc107; background: #fff3cd; }
        .chart-container { height: 200px; background: #f8f9fa; border-radius: 4px; display: flex; align-items: center; justify-content: center; }
    </style>
</head>
<body>
    <h1>🔍 BS9 Advanced Monitoring Dashboard</h1>
    
    <div class="dashboard">
        ${widgets.map(widget => this.renderWidget(widget)).join('')}
    </div>
    
    <script>
        // Auto-refresh widgets
        setInterval(() => {
            fetch('/api/advanced-metrics')
                .then(response => response.json())
                .then(data => {
                    updateWidgets(data);
                })
                .catch(error => console.error('Failed to fetch metrics:', error));
        }, 5000);
        
        function updateWidgets(data) {
            // Update widget content based on data
            console.log('Updating widgets with data:', data);
        }
    </script>
</body>
</html>`;
  }
  
  private renderWidget(widget: AdvancedWidget): string {
    switch (widget.type) {
      case 'metric':
        return `
          <div class="widget" style="grid-column: span ${Math.ceil(widget.position.width / 300)};">
            <div class="widget-header">${widget.title}</div>
            <div class="widget-content">
              <div class="metric-value" id="${widget.id}-value">${typeof widget.config.value === 'number' ? widget.config.value : '--'}</div>
              <span class="metric-unit">${widget.config.unit}</span>
            </div>
          </div>
        `;
      
      case 'chart':
        return `
          <div class="widget" style="grid-column: span ${Math.ceil(widget.position.width / 300)};">
            <div class="widget-header">${widget.title}</div>
            <div class="widget-content">
              <div class="chart-container">
                📊 ${widget.config.chartType.toUpperCase()} Chart
              </div>
            </div>
          </div>
        `;
      
      case 'alert':
        return `
          <div class="widget" style="grid-column: span ${Math.ceil(widget.position.width / 300)};">
            <div class="widget-header">${widget.title}</div>
            <div class="widget-content" id="${widget.id}-alerts">
              <div class="alert-item">No active alerts</div>
            </div>
          </div>
        `;
      
      default:
        return `
          <div class="widget">
            <div class="widget-header">${widget.title}</div>
            <div class="widget-content">
              Custom widget content
            </div>
          </div>
        `;
    }
  }
}

export async function advancedMonitoringCommand(options: any): Promise<void> {
  const monitoring = new AdvancedMonitoring();
  
  console.log('🔍 Starting Advanced Monitoring Dashboard...');
  console.log('📊 Features:');
  console.log('   - Custom widgets');
  console.log('   - Anomaly detection');
  console.log('   - Alert correlation');
  console.log('   - Performance baselines');
  
  const server = serve({
    port: options.port || 8090,
    async fetch(req) {
      const url = new URL(req.url);
      
      if (url.pathname === '/') {
        return new Response(monitoring.generateDashboard(), {
          headers: { 'Content-Type': 'text/html' }
        });
      }
      
      if (url.pathname === '/api/advanced-metrics') {
        // Mock advanced metrics data
        const metrics = {
          widgets: monitoring.getWidgets(),
          anomalies: monitoring.getAnomalies(),
          correlations: monitoring.getCorrelations(),
          timestamp: Date.now()
        };
        
        return new Response(JSON.stringify(metrics), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      return new Response('Not Found', { status: 404 });
    }
  });
  
  console.log(`✅ Advanced monitoring dashboard started on http://localhost:${options.port || 8090}`);
  console.log('🔗 Features available:');
  console.log('   - Real-time anomaly detection');
  console.log('   - Alert correlation analysis');
  console.log('   - Custom widget configuration');
  console.log('   - Performance baseline tracking');
}
