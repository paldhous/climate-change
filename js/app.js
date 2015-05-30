;(function() {
// ensure console
if (_.isUndefined(window.console)) {
    window.console = {
        log: function() {},
        time: function() {},
        timeEnd: function() {}
    };
}

// fix Leaflet's image problem
L.Icon.Default.imagePath = "components/leaflet/images";

var Layer = Backbone.Model.extend({

    defaults: {
        name: "",
        id: "",
        tilejson: {}
    },

    url: function() {
        var ids = ['mapbox.world-light', this.id].join(',');
        return "http://a.tile.mapbox.com/v3/" + ids + ".jsonp";
    }
});


var LayerSet = Backbone.Collection.extend({
    model: Layer
});

var layers = new LayerSet([
    {
        id: "paldhous.1994-2013",
        name: "1994 - 2013"
    },
    
    {
        id: "paldhous.1974-1993",
        name: "1974 - 1993"
    },
    {
        id: "paldhous.1954-1973",
        name: "1955 - 1973"
    },
    {
        id: "paldhous.1934-1953",
        name: "1934 - 1953"
    },
    {
        id: "paldhous.1914-1933", 
        name: "1914 - 1933"
    },
    {
        id: "paldhous.1894-1913",
        name: "1894 - 1913"
    }
]);

var LayerMenu = Backbone.View.extend({

    el: "#menu",

    events: {
        "change select" : "setLayer"
    },

    initialize: function(options) {
        _.bindAll(this);
        this.app = options.app;
        this.layers = layers;
        return this.render();
    },

    setLayer: function(e) {
        var id = $(e.target).val()
          , layer = this.layers.get(id)
          , url = layer.url();

        this.app.setMapLayer(url);
    },

    render: function() {
        var select = this.$el.find('select').empty();
        this.layers.each(function(layer) {
            var option = $('<option/>')
                .attr('value', layer.get('id'))
                .text(layer.get('name'))
                .appendTo(select);
        });

        return this;
    }
});

var mapOptions = {
    minzoom: 2,
    maxzoom: 6,
    unloadInvisibleTiles: true
};

var App = Backbone.View.extend({

    el: 'body',

    events: {
        "click   #location" : "locate",
        "submit  form"      : "geocode"
    },

    initialize: function(options) {
        _.bindAll(this);

        // create big moving parts
        this.cache = { hits: 0, misses: 0 };
        this.highchart = localChart('local-chart');
        this.globalchart = globalChart('global-chart');

        // menu, with layers
        this.menu = new LayerMenu({ app: this });

        // map parts
        this.map = this.createMap(this.menu.layers.first().url(), this.setupMap);
        this.marker = L.marker([0,0], { clickable: true, draggable: true });

        // grid data
        this.annual = new Grid('data/grid/annual');
        this.fiveyear = new Grid('data/grid/fiveyear');

        // stash a spinner
        this.spinner = new Spinner({
            lines: 9,
            length: 4,
            width: 4,
            radius: 5
        });

        return this;
    },

    getset: function(data, field) {
        // get or set cache for a location
        var key = data.lng_id + ':' + data.lat_id + ':' + field;
        if (_.has(this.cache, key)) {
            this.cache.hits++;
            return this.cache[key];
        } else {
            this.cache.misses++;
            this.cache[key] = JSON.parse(data[field]);
            return this.cache[key];
        }
    },

    geocode: function(e) {
        e.preventDefault();

        var query = this.$('#search').find('input').val()
          , app = this;

        if ($.trim(query)) {
            mapbox_geocode(query, function(resp) {
                // window.resp = resp;
                if (resp.results) {
                    var loc = resp.results[0][0];
                    app.setView([loc.lat, loc.lon], null, e);                    
                }
            });
        }
        return false;
    },

    locate: function(e) {
        if (e) e.preventDefault();

        var app = this;
        app.map.locate()
            .on('locationfound', function(e) {
                app.setView([e.latlng.lat, e.latlng.lng], null, e);
            });
    },

    setMarker: function(latlng) {
        // set a marker, not a view
        var app = this;
        latlng = L.latLng(latlng);
        this.showSpinner();
        // console.time('Redraw');
        this.marker.setLatLng(latlng);
        this.marker.addTo(this.map);
        // console.log(latlng);
        
        queue()
            .defer(app.annual.getTile, latlng.lat, latlng.lng)
            .defer(app.fiveyear.getTile, latlng.lat, latlng.lng)
            .await(redraw);

        function redraw(err, annual, fiveyear) {
            app.plotSeries('annual', annual, false);
            app.plotSeries('fiveyear', fiveyear, false);
            app.highchart.redraw();
            app.stopSpinner();
            // console.timeEnd('Redraw');
        }
    },

    setView: function(latlng, zoom, e) {
        zoom = (zoom || this.map.getMaxZoom());
        e = (e || { type: 'click' });
        //var c = L.latLng(latlng);
        this.map.setView(latlng, zoom);
        this.setMarker(latlng);
        return this;
    },

    createMap: function(url, cb) {
        var map = L.map('map', { worldCopyJump: true })
          , app = this;

        wax.tilejson(url, function(tilejson) {
            _.extend(tilejson, mapOptions);
            app.tilejson = tilejson;
            app.layer = new TileJsonLayer(tilejson);

            map.addLayer(app.layer);

            // put zoom controls in the upper right
            // map.zoomControl.setPosition('topright');

            // remove leaflet attribution, sorry leaflet
            map.attributionControl.setPrefix('');

            if (_.isFunction(cb)) cb(map, tilejson);
        });

        // return the map immediately
        return map;
    },

    plot: function(e) {
        //console.time('Redraw');
        app.e = e;
        this.highchart.annual.setData(JSON.parse(e.data.annual), false);
        this.highchart.fiveyear.setData(JSON.parse(e.data.fiveyear), false);
        this.highchart.redraw();
        // console.log([e.data.lat_id, e.data.lng_id]);
        this.stopSpinner();
        //console.timeEnd('Redraw');
    },

    plotSeries: function(series, data, redraw) {

        // i hate ie8
        var serieses = {
            annual: this.highchart.series[0],
            fiveyear: this.highchart.series[1]
        };

        series = serieses[series];
        series.setData(data, redraw);
    },

    setupMap: function(map, tilejson) {
        var app = this;

        map.on('click', function(e) {
            app.setMarker(e.latlng, map.getZoom(), e);
        });

        this.marker.on('dragend', function(e) {
            var marker = e.target;
            app.setMarker(marker.getLatLng());
        });

        jQuery(function($) {
            app.setView([50, 0], 3);
        });

    },

    setMapLayer: function(url) {
        var map = this.map
          , app = this;

        wax.tilejson(url, function(tilejson) {
            map.removeLayer(app.layer);

            _.extend(tilejson, mapOptions);
            app.tilejson = tilejson;

            app.layer = new TileJsonLayer(tilejson);
            map.addLayer(app.layer);
        });
    },

    showSpinner: function() {
        this.spinner.spin();
        $('#spinner').append(this.spinner.el);
        return this;
    },

    stopSpinner: function() {
        this.spinner.stop();
        return this;
    }
});

var TileJsonLayer = L.TileLayer.extend({
    initialize: function(options) {
        options = options || {};
        options.minZoom = options.minzoom || 0;
        options.maxZoom = options.maxzoom || 22;
        var tile_url = options.tiles[0].replace('a.tiles', '{s}.tiles');
        L.TileLayer.prototype.initialize.call(this, tile_url, options);
    }
});


// when all is ready, create the app
window.app = new App();

})();