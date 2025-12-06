import pandas as pd
import numpy as np
import json
from dowhy import CausalModel

# ===============================
# 1. Load & Prepare Data
# ===============================
orders = pd.read_csv('orders.csv')
items = pd.read_csv('order_items.csv')
customers = pd.read_csv('customers.csv')
sellers = pd.read_csv('sellers.csv')
geo = pd.read_csv('geolocation.csv')

# Aggregate geolocations (median lat/lng per zip)
geo_agg = geo.groupby('geolocation_zip_code_prefix')[['geolocation_lat', 'geolocation_lng']].median().reset_index()

# Merge datasets
df = orders.merge(items[['order_id', 'seller_id']], on='order_id')
df = df.merge(customers[['customer_id', 'customer_state', 'customer_zip_code_prefix']], on='customer_id')
df = df.merge(sellers[['seller_id', 'seller_state', 'seller_zip_code_prefix']], on='seller_id')

# Parse dates and calculate delivery delay
df['order_purchase_timestamp'] = pd.to_datetime(df['order_purchase_timestamp'])
df['order_delivered_customer_date'] = pd.to_datetime(df['order_delivered_customer_date'])
df = df.dropna(subset=['order_delivered_customer_date', 'order_purchase_timestamp'])
df['delivery_delay'] = (df['order_delivered_customer_date'] - df['order_purchase_timestamp']).dt.days
df = df[df['delivery_delay'] >= 0]

# Merge lat/lng for Haversine distance
df = df.merge(geo_agg, left_on='seller_zip_code_prefix', right_on='geolocation_zip_code_prefix', how='left') \
       .rename(columns={'geolocation_lat': 'lat_seller', 'geolocation_lng': 'lng_seller'})
df = df.merge(geo_agg, left_on='customer_zip_code_prefix', right_on='geolocation_zip_code_prefix', how='left') \
       .rename(columns={'geolocation_lat': 'lat_cust', 'geolocation_lng': 'lng_cust'})

def haversine_np(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = map(np.radians, [lon1, lat1, lon2, lat2])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = np.sin(dlat/2.0)**2 + np.cos(lat1)*np.cos(lat2)*np.sin(dlon/2.0)**2
    c = 2 * np.arcsin(np.sqrt(a))
    km = 6367 * c
    return km

df['distance_km'] = haversine_np(df['lng_seller'], df['lat_seller'], df['lng_cust'], df['lat_cust'])
df = df.dropna(subset=['distance_km'])

# ===============================
# 2. Define Hubs, States & Hypotheses
# ===============================
hubs = ['SP', 'RJ', 'MG', 'PR', 'RS']  # Major hubs
far_states = ['AM', 'RR', 'AP', 'AC', 'RO', 'PA', 'TO']
neighbor_states = ['MG', 'PR', 'RJ', 'ES', 'SC']
weekday_orders = [0,1,2,3,4]  # Monday-Friday
weekend_orders = [5,6]        # Saturday-Sunday
high_order_threshold = df['order_item_id'].value_counts().quantile(0.75)  # top 25% items by frequency

findings_list = []

# ===============================
# 3. Run Causal Models for Each Hypothesis
# ===============================
for hub in hubs:
    hub_data = df[df['seller_state'] == hub].copy()
    
    # Far states effect
    hub_data['is_far'] = hub_data['customer_state'].isin(far_states)
    model_far = CausalModel(
        data=hub_data,
        treatment='is_far',
        outcome='delivery_delay',
        common_causes=['distance_km']
    )
    estimate_far = model_far.estimate_effect(
        model_far.identify_effect(proceed_when_unidentifiable=True),
        method_name="backdoor.linear_regression"
    )
    if estimate_far.value > 0:
        findings_list.append({
            "source": hub,
            "effect": "distance",
            "val": f"+{estimate_far.value:.1f}d",
            "type": "bad"
        })

    # Neighbor states effect
    hub_data['is_neighbor'] = hub_data['customer_state'].isin(neighbor_states)
    model_neighbor = CausalModel(
        data=hub_data,
        treatment='is_neighbor',
        outcome='delivery_delay',
        common_causes=['distance_km']
    )
    estimate_neighbor = model_neighbor.estimate_effect(
        model_neighbor.identify_effect(proceed_when_unidentifiable=True),
        method_name="backdoor.linear_regression"
    )
    if estimate_neighbor.value < 0:
        findings_list.append({
            "source": hub,
            "effect": "hub",
            "val": f"{estimate_neighbor.value:.1f}d",
            "type": "good"
        })
    
    # Weekend effect
    hub_data['weekday'] = hub_data['order_purchase_timestamp'].dt.dayofweek
    hub_data['is_weekend'] = hub_data['weekday'].isin(weekend_orders)
    model_weekend = CausalModel(
        data=hub_data,
        treatment='is_weekend',
        outcome='delivery_delay',
        common_causes=['distance_km']
    )
    estimate_weekend = model_weekend.estimate_effect(
        model_weekend.identify_effect(proceed_when_unidentifiable=True),
        method_name="backdoor.linear_regression"
    )
    if estimate_weekend.value != 0:
        findings_list.append({
            "source": hub,
            "effect": "weekend",
            "val": f"{estimate_weekend.value:.1f}d",
            "type": "info"
        })
    
    # High order effect
    high_orders = hub_data['order_item_id'].map(hub_data['order_item_id'].value_counts()) >= high_order_threshold
    hub_data['is_high_order'] = high_orders
    model_high_order = CausalModel(
        data=hub_data,
        treatment='is_high_order',
        outcome='delivery_delay',
        common_causes=['distance_km']
    )
    estimate_high_order = model_high_order.estimate_effect(
        model_high_order.identify_effect(proceed_when_unidentifiable=True),
        method_name="backdoor.linear_regression"
    )
    if estimate_high_order.value != 0:
        findings_list.append({
            "source": hub,
            "effect": "high_order",
            "val": f"{estimate_high_order.value:.1f}d",
            "type": "info"
        })

# ===============================
# 4. Export Findings
# ===============================
with open('causal_data_full.json', 'w') as f:
    json.dump(findings_list, f, indent=4)

print("✅ Expanded causal analysis complete. Findings saved in 'causal_data_full.json'")
